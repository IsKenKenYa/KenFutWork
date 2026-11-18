use crate::windows_conpty::PseudoConsole;
use crate::windows_handles::{ProcessJob, check, own};
use anyhow::{Context, Result, ensure};
use std::ffi::c_void;
use std::fs::File;
use std::mem::size_of;
use std::os::windows::io::{AsRawHandle, OwnedHandle};
use windows_sys::Win32::System::Threading::*;
use wxc_common::cmdline::{CommandLineContext, cmdline_from_argv_for_context};

struct Attributes {
    buffer: Vec<usize>,
    initialized: bool,
}
impl Attributes {
    fn new(
        handles: &[windows_sys::Win32::Foundation::HANDLE],
        console: Option<&PseudoConsole>,
    ) -> Result<Self> {
        let count = 1 + u32::from(console.is_some());
        let mut bytes = 0;
        unsafe {
            InitializeProcThreadAttributeList(std::ptr::null_mut(), count, 0, &mut bytes);
        }
        ensure!(bytes > 0, "属性列表尺寸探针失败");
        let mut attributes = Self {
            buffer: vec![0; bytes.div_ceil(size_of::<usize>())],
            initialized: false,
        };
        check(
            unsafe { InitializeProcThreadAttributeList(attributes.raw(), count, 0, &mut bytes) },
            "InitializeProcThreadAttributeList",
        )?;
        attributes.initialized = true;
        check(
            unsafe {
                UpdateProcThreadAttribute(
                    attributes.raw(),
                    0,
                    PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                    handles.as_ptr() as *const c_void,
                    std::mem::size_of_val(handles),
                    std::ptr::null_mut(),
                    std::ptr::null(),
                )
            },
            "Controller handle list",
        )?;
        if let Some(console) = console {
            check(
                unsafe {
                    UpdateProcThreadAttribute(
                        attributes.raw(),
                        0,
                        PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE as usize,
                        console.raw()? as *const c_void,
                        size_of::<windows_sys::Win32::System::Console::HPCON>(),
                        std::ptr::null_mut(),
                        std::ptr::null(),
                    )
                },
                "Controller ConPTY attribute",
            )?;
        }
        Ok(attributes)
    }
    fn raw(&mut self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
        self.buffer.as_mut_ptr().cast()
    }
}
impl Drop for Attributes {
    fn drop(&mut self) {
        if self.initialized {
            unsafe {
                DeleteProcThreadAttributeList(self.raw());
            }
        }
    }
}
struct Suspended {
    process: OwnedHandle,
    thread: OwnedHandle,
    armed: bool,
}
impl Drop for Suspended {
    fn drop(&mut self) {
        if self.armed {
            unsafe {
                TerminateProcess(self.process.as_raw_handle(), u32::MAX);
                WaitForSingleObject(self.process.as_raw_handle(), INFINITE);
            }
        }
    }
}

pub fn start_controller(
    job: &ProcessJob,
    read: &File,
    write: &File,
    console: Option<&PseudoConsole>,
) -> Result<(OwnedHandle, u32)> {
    let query = job.query_duplicate()?;
    let handles = [
        read.as_raw_handle(),
        write.as_raw_handle(),
        query.as_raw_handle(),
    ];
    let executable = std::env::current_exe()?;
    let args = vec![
        executable.to_string_lossy().into_owned(),
        "--kfw-task-controller".to_owned(),
        (handles[0] as usize).to_string(),
        (handles[1] as usize).to_string(),
        (handles[2] as usize).to_string(),
    ];
    let command = cmdline_from_argv_for_context(&args, CommandLineContext::WindowsCreateProcess)?;
    let mut command: Vec<u16> = command.encode_utf16().chain(Some(0)).collect();
    let exe: Vec<u16> = executable
        .to_string_lossy()
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let directory: Vec<u16> = executable
        .parent()
        .context("broker 缺少固定目录")?
        .to_string_lossy()
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let mut attributes = Attributes::new(&handles, console)?;
    let startup = STARTUPINFOEXW {
        StartupInfo: STARTUPINFOW {
            cb: size_of::<STARTUPINFOEXW>() as u32,
            ..Default::default()
        },
        lpAttributeList: attributes.raw(),
    };
    let mut information = PROCESS_INFORMATION::default();
    let flags = CREATE_SUSPENDED
        | EXTENDED_STARTUPINFO_PRESENT
        | if console.is_none() {
            CREATE_NO_WINDOW
        } else {
            0
        };
    // Only fixed controller argv is launched here. User argv/env is carried on private IPC and applied by MXC/PSEC.
    check(
        unsafe {
            CreateProcessW(
                exe.as_ptr(),
                command.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                1,
                flags,
                std::ptr::null(),
                directory.as_ptr(),
                &startup.StartupInfo,
                &mut information,
            )
        },
        "Create controller",
    )?;
    let mut child = Suspended {
        process: own(information.hProcess)?,
        thread: own(information.hThread)?,
        armed: true,
    };
    job.assign(child.process.as_raw_handle())?;
    let previous = unsafe { ResumeThread(child.thread.as_raw_handle()) };
    ensure!(
        previous != u32::MAX && previous > 0,
        "controller 未保留 suspended→Job→resume 顺序"
    );
    child.armed = false;
    let process = own({
        // Move rather than duplicate the process handle out of the armed launch guard.
        use std::os::windows::io::IntoRawHandle;
        std::mem::replace(&mut child.process, query).into_raw_handle()
    })?;
    Ok((process, information.dwProcessId))
}
