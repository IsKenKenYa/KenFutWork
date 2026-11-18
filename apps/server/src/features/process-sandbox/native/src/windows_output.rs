use anyhow::{Result, ensure};
use base64::Engine;
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;

pub type Emitter = Arc<Mutex<Box<dyn Write + Send>>>;
pub fn emit(output: &Emitter, message: Value) -> Result<()> {
    let mut writer = output
        .lock()
        .map_err(|_| anyhow::anyhow!("broker 输出锁不可用"))?;
    serde_json::to_writer(&mut *writer, &message)?;
    writer.write_all(b"\n")?;
    writer.flush()?;
    Ok(())
}

#[derive(Default)]
struct AckState {
    sequence: u64,
    pending: Option<u64>,
    cancelled: bool,
    reader: bool,
}
#[derive(Default)]
pub struct AckGate {
    state: Mutex<AckState>,
    changed: Condvar,
}
impl AckGate {
    pub fn issue(&self) -> Result<u64> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| anyhow::anyhow!("ACK 锁不可用"))?;
        ensure!(state.pending.is_none() || state.cancelled, "上一帧未 ACK");
        state.sequence += 1;
        if !state.cancelled {
            state.pending = Some(state.sequence);
        }
        Ok(state.sequence)
    }
    pub fn wait(&self) -> Result<()> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| anyhow::anyhow!("ACK 锁不可用"))?;
        while state.pending.is_some() && !state.cancelled {
            state = self
                .changed
                .wait(state)
                .map_err(|_| anyhow::anyhow!("ACK 等待失败"))?;
        }
        Ok(())
    }
    pub fn acknowledge(&self, sequence: u64) -> Result<()> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| anyhow::anyhow!("ACK 锁不可用"))?;
        ensure!(sequence > 0 && sequence <= state.sequence, "ACK 序号无效");
        if state.pending == Some(sequence) {
            state.pending = None;
            self.changed.notify_all();
        }
        Ok(())
    }
    pub fn reader(&self, active: bool) -> Result<()> {
        self.state
            .lock()
            .map_err(|_| anyhow::anyhow!("ACK 锁不可用"))?
            .reader = active;
        Ok(())
    }
    pub fn natural_pty_exit(&self) -> Result<()> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| anyhow::anyhow!("ACK 锁不可用"))?;
        if !state.reader {
            state.cancelled = true;
            state.pending = None;
            self.changed.notify_all();
        }
        Ok(())
    }
    pub fn cancel(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.cancelled = true;
            state.pending = None;
            self.changed.notify_all();
        }
    }
}

pub fn stream_output(
    mut reader: Box<dyn Read + Send>,
    output: Emitter,
    process_id: String,
    stream: &'static str,
    chunk_bytes: usize,
    gate: Option<Arc<AckGate>>,
) -> thread::JoinHandle<Result<()>> {
    thread::spawn(move || {
        let mut buffer = vec![0u8; chunk_bytes];
        loop {
            let read = reader.read(&mut buffer)?;
            if read == 0 {
                emit(
                    &output,
                    json!({"event":"stream-end","processId":process_id,"stream":stream}),
                )?;
                return Ok(());
            }
            let sequence = gate.as_ref().map(|gate| gate.issue()).transpose()?;
            emit(
                &output,
                json!({"event":"output","processId":process_id,"stream":stream,
                "sequence":sequence,"data":base64::engine::general_purpose::STANDARD.encode(&buffer[..read])}),
            )?;
            if let Some(gate) = &gate {
                gate.wait()?;
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    fn waiting(
        gate: Arc<AckGate>,
    ) -> (
        mpsc::Receiver<()>,
        mpsc::Receiver<()>,
        thread::JoinHandle<()>,
    ) {
        let (entered, ready) = mpsc::channel();
        let (finished, done) = mpsc::channel();
        let worker = thread::spawn(move || {
            entered.send(()).unwrap();
            gate.wait().unwrap();
            finished.send(()).unwrap();
        });
        (ready, done, worker)
    }
    #[test]
    fn future_ack_cannot_release_current_frame_and_replay_is_idempotent() {
        let gate = Arc::new(AckGate::default());
        assert_eq!(gate.issue().unwrap(), 1);
        let (ready, done, worker) = waiting(Arc::clone(&gate));
        ready.recv().unwrap();
        assert!(done.try_recv().is_err());
        assert!(gate.acknowledge(2).is_err());
        assert!(gate.issue().is_err());
        assert!(done.try_recv().is_err());
        gate.acknowledge(1).unwrap();
        done.recv_timeout(Duration::from_secs(2)).unwrap();
        worker.join().unwrap();
        gate.acknowledge(1).unwrap();
        assert_eq!(gate.issue().unwrap(), 2);
    }
    #[test]
    fn active_pty_reader_keeps_exit_tail_until_ack_but_no_reader_resumes_capture() {
        let gate = Arc::new(AckGate::default());
        gate.reader(true).unwrap();
        gate.issue().unwrap();
        gate.natural_pty_exit().unwrap();
        let (ready, done, worker) = waiting(Arc::clone(&gate));
        ready.recv().unwrap();
        assert!(done.try_recv().is_err());
        gate.acknowledge(1).unwrap();
        done.recv_timeout(Duration::from_secs(2)).unwrap();
        worker.join().unwrap();
        let gate = Arc::new(AckGate::default());
        gate.issue().unwrap();
        gate.natural_pty_exit().unwrap();
        gate.wait().unwrap();
        assert_eq!(gate.issue().unwrap(), 2);
        gate.wait().unwrap();
    }
    #[test]
    fn stop_cancel_unblocks_held_native_reader_without_losing_sequence_identity() {
        let gate = Arc::new(AckGate::default());
        gate.issue().unwrap();
        let (ready, done, worker) = waiting(Arc::clone(&gate));
        ready.recv().unwrap();
        assert!(done.try_recv().is_err());
        gate.cancel();
        done.recv_timeout(Duration::from_secs(2)).unwrap();
        worker.join().unwrap();
        gate.acknowledge(1).unwrap();
        assert_eq!(gate.issue().unwrap(), 2);
    }
}
