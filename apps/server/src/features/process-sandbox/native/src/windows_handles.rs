use anyhow::{Result, ensure};
use std::ffi::c_void;
use std::fs::File;
use std::mem::size_of;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::thread;
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{
    DuplicateHandle, HANDLE, HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE, SetHandleInformation,
};
use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
use windows_sys::Win32::System::JobObjects::*;
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::SystemServices::JOB_OBJECT_QUERY;
use windows_sys::Win32::System::Threading::GetCurrentProcess;

pub fn check(value: i32, operation: &str) -> Result<()> {
    ensure!(
        value != 0,
        "{operation}: {}",
        std::io::Error::last_os_error()
    );
    Ok(())
}
pub fn own(raw: HANDLE) -> Result<OwnedHandle> {
    ensure!(
        !raw.is_null() && raw != INVALID_HANDLE_VALUE,
        "Windows handle 无效"
    );
    Ok(unsafe { OwnedHandle::from_raw_handle(raw) })
}
pub fn inherited(handle: HANDLE, enabled: bool) -> Result<()> {
    check(
        unsafe {
            SetHandleInformation(
                handle,
                HANDLE_FLAG_INHERIT,
                if enabled { HANDLE_FLAG_INHERIT } else { 0 },
            )
        },
        "SetHandleInformation",
    )
}
pub fn pipe(read_inherited: bool, write_inherited: bool) -> Result<(File, File)> {
    let mut read = std::ptr::null_mut();
    let mut write = std::ptr::null_mut();
    let attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: std::ptr::null_mut(),
        bInheritHandle: 1,
    };
    check(
        unsafe { CreatePipe(&mut read, &mut write, &attributes, 0) },
        "CreatePipe",
    )?;
    let read = own(read)?;
    let write = own(write)?;
    inherited(read.as_raw_handle(), read_inherited)?;
    inherited(write.as_raw_handle(), write_inherited)?;
    Ok((File::from(read), File::from(write)))
}

pub struct ProcessJob {
    handle: OwnedHandle,
}
impl ProcessJob {
    pub fn new() -> Result<Self> {
        let handle = own(unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) })?;
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        check(
            unsafe {
                SetInformationJobObject(
                    handle.as_raw_handle(),
                    JobObjectExtendedLimitInformation,
                    &limits as *const _ as *const c_void,
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            },
            "Job limits",
        )?;
        Ok(Self { handle })
    }
    pub fn from_query(handle: OwnedHandle) -> Result<Self> {
        inherited(handle.as_raw_handle(), false)?;
        let mut assigned = 0;
        check(
            unsafe { IsProcessInJob(GetCurrentProcess(), handle.as_raw_handle(), &mut assigned) },
            "Controller Job identity",
        )?;
        ensure!(assigned != 0, "controller 未绑定预先签发的 Job");
        Ok(Self { handle })
    }
    pub fn raw(&self) -> HANDLE {
        self.handle.as_raw_handle()
    }
    pub fn assign(&self, process: HANDLE) -> Result<()> {
        check(
            unsafe { AssignProcessToJobObject(self.raw(), process) },
            "AssignProcessToJobObject",
        )
    }
    pub fn query_duplicate(&self) -> Result<OwnedHandle> {
        let mut handle = std::ptr::null_mut();
        check(
            unsafe {
                DuplicateHandle(
                    GetCurrentProcess(),
                    self.raw(),
                    GetCurrentProcess(),
                    &mut handle,
                    JOB_OBJECT_QUERY,
                    1,
                    0,
                )
            },
            "Duplicate Job query",
        )?;
        own(handle)
    }
    pub fn active(&self) -> Result<u32> {
        let mut accounting = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        check(
            unsafe {
                QueryInformationJobObject(
                    self.raw(),
                    JobObjectBasicAccountingInformation,
                    &mut accounting as *mut _ as *mut c_void,
                    size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                    std::ptr::null_mut(),
                )
            },
            "QueryInformationJobObject",
        )?;
        Ok(accounting.ActiveProcesses)
    }
    pub fn terminate(&self) -> Result<()> {
        check(
            unsafe { TerminateJobObject(self.raw(), u32::MAX) },
            "TerminateJobObject",
        )
    }
    pub fn process_ids(&self) -> Result<Vec<usize>> {
        let mut needed: u32 = 0;
        unsafe {
            QueryInformationJobObject(
                self.raw(),
                JobObjectBasicProcessIdList,
                std::ptr::null_mut(),
                0,
                &mut needed,
            );
        }
        if needed == 0 {
            return Ok(Vec::new());
        }
        let mut buffer = vec![0u8; needed as usize];
        check(
            unsafe {
                QueryInformationJobObject(
                    self.raw(),
                    JobObjectBasicProcessIdList,
                    buffer.as_mut_ptr() as *mut c_void,
                    needed,
                    &mut needed,
                )
            },
            "Query ProcessIdList",
        )?;
        let list = unsafe { &*(buffer.as_ptr() as *const JOBOBJECT_BASIC_PROCESS_ID_LIST) };
        Ok(unsafe {
            std::slice::from_raw_parts(
                list.ProcessIdList.as_ptr(),
                list.NumberOfProcessIdsInList as usize,
            )
        }
        .to_vec())
    }
    pub fn wait_active(&self, expected: u32, grace_ms: u64, yield_ms: u64) -> Result<()> {
        let started = Instant::now();
        loop {
            if self.active()? == expected {
                return Ok(());
            }
            if started.elapsed() >= Duration::from_millis(grace_ms) {
                // ActiveProcesses 对「已退出但句柄/引用尚未收尾」的成员保持计数，
                // 且 TerminateJobObject 之后清零仍是异步的。真实判据是成员列表：
                // 查询成功且列表长度不超过期望值，就没有存活进程需要确认。
                match self.process_ids() {
                    Ok(ids) if ids.len() <= expected as usize => return Ok(()),
                    Ok(ids) => {
                        let active = self.active().unwrap_or_default();
                        anyhow::bail!(
                            "Job 范围仍有进程，停止未确认（active={}，成员={}：{:?}）",
                            active,
                            ids.len(),
                            ids
                        );
                    }
                    Err(error) => {
                        anyhow::bail!(
                            "Job 范围停止未确认，且成员列表查询失败：{error}"
                        );
                    }
                }
            }
            thread::sleep(Duration::from_millis(yield_ms));
        }
    }
}
