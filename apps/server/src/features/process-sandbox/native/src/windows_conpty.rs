use crate::windows_handles::{check, own, pipe};
use crate::windows_protocol::PtySize;
use anyhow::{Result, ensure};
use std::fs::File;
use std::os::windows::io::AsRawHandle;
use std::sync::{Arc, Mutex};
use windows_sys::Win32::Foundation::{GENERIC_READ, GENERIC_WRITE};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
};
use windows_sys::Win32::System::Console::*;

pub struct PseudoConsole {
    handle: Mutex<Option<HPCON>>,
}
impl PseudoConsole {
    pub fn create(size: &PtySize) -> Result<(Arc<Self>, File, File)> {
        ensure!(size.cols > 1 && size.rows > 0, "ConPTY 尺寸无效");
        let (input_read, input_write) = pipe(false, false)?;
        let (output_read, output_write) = pipe(false, false)?;
        let mut handle = 0;
        let status = unsafe {
            CreatePseudoConsole(
                COORD {
                    X: size.cols,
                    Y: size.rows,
                },
                input_read.as_raw_handle(),
                output_write.as_raw_handle(),
                0,
                &mut handle,
            )
        };
        ensure!(status >= 0, "CreatePseudoConsole 失败：{status:#x}");
        // ConPTY owns duplicates; parent keeps only its input writer and output reader.
        drop(input_read);
        drop(output_write);
        Ok((
            Arc::new(Self {
                handle: Mutex::new(Some(handle)),
            }),
            input_write,
            output_read,
        ))
    }
    pub fn raw(&self) -> Result<HPCON> {
        self.handle
            .lock()
            .map_err(|_| anyhow::anyhow!("ConPTY 锁不可用"))?
            .context("ConPTY 已关闭")
    }
    pub fn resize(&self, cols: i16, rows: i16) -> Result<()> {
        ensure!(cols > 1 && rows > 0, "ConPTY 尺寸无效");
        let locked = self
            .handle
            .lock()
            .map_err(|_| anyhow::anyhow!("ConPTY 锁不可用"))?;
        let handle = locked.context("ConPTY 已关闭")?;
        let status = unsafe { ResizePseudoConsole(handle, COORD { X: cols, Y: rows }) };
        ensure!(status >= 0, "ResizePseudoConsole 失败：{status:#x}");
        Ok(())
    }
    pub fn close(&self) -> Result<()> {
        let handle = self
            .handle
            .lock()
            .map_err(|_| anyhow::anyhow!("ConPTY 锁不可用"))?
            .take();
        // Never hold the handle mutex while ClosePseudoConsole drains output: ACK/control must keep running.
        if let Some(handle) = handle {
            unsafe {
                ClosePseudoConsole(handle);
            }
        }
        Ok(())
    }
}
impl Drop for PseudoConsole {
    fn drop(&mut self) {
        if let Ok(handle) = self.handle.get_mut() {
            if let Some(handle) = handle.take() {
                unsafe {
                    ClosePseudoConsole(handle);
                }
            }
        }
    }
}
use anyhow::Context;

pub fn probe() -> Result<()> {
    // Win32 probe uses the minimum valid size; this is not a terminal default or business limit.
    let (console, input, output) = PseudoConsole::create(&PtySize { cols: 2, rows: 1 })?;
    console.close()?;
    drop(input);
    drop(output);
    Ok(())
}

/** The controller's native stdio belongs to its ConPTY; its private IPC uses separate handles. */
pub fn attach_standard_console() -> Result<Vec<File>> {
    let mut files = Vec::new();
    for (name, standard) in [
        ("CONIN$", STD_INPUT_HANDLE),
        ("CONOUT$", STD_OUTPUT_HANDLE),
        ("CONOUT$", STD_ERROR_HANDLE),
    ] {
        let wide: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
        let file = File::from(own(unsafe {
            CreateFileW(
                wide.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                std::ptr::null(),
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL,
                std::ptr::null_mut(),
            )
        })?);
        let mut mode = 0;
        check(
            unsafe { GetConsoleMode(file.as_raw_handle(), &mut mode) },
            "Controller console identity",
        )?;
        check(
            unsafe { SetStdHandle(standard, file.as_raw_handle()) },
            "SetStdHandle",
        )?;
        files.push(file);
    }
    Ok(files)
}
