/* KenFutWork 同 Task helper 的 macOS PTY session 范围探针；不拥有第二套运行时。 */
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <libproc.h>
#include <limits.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc.h>
#include <unistd.h>

typedef struct { pid_t pid; struct proc_bsdinfo info; } Member;
typedef struct { pid_t session; uint64_t sec; uint64_t usec; } Identity;
extern char **environ;

static void fail(const char *message) {
  fprintf(stderr, "PTY session 范围检查失败：%s（errno=%d）\n", message, errno);
  exit(2);
}

static int process_info(pid_t pid, struct proc_bsdinfo *info) {
  errno = 0;
  int size = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, info, sizeof(*info));
  if (size == sizeof(*info)) return 1;
  errno = 0;
  if (getsid(pid) == -1 && errno == ESRCH) return 0;
  fail("无法读取进程身份");
  return 0;
}

static int verify_leader(Identity *identity, int initial) {
  struct proc_bsdinfo info;
  if (!process_info(identity->session, &info)) {
    if (initial) fail("PTY leader 已退出，不能签发新范围身份");
    return 0;
  }
  if (getsid(identity->session) != identity->session) fail("PTY leader 不是 session leader");
  if (initial) { identity->sec = info.pbi_start_tvsec; identity->usec = info.pbi_start_tvusec; }
  if (info.pbi_start_tvsec != identity->sec || info.pbi_start_tvusec != identity->usec)
    fail("PTY leader PID 已复用，禁止影响新会话");
  return 1;
}

static pid_t *process_ids(int *length) {
  for (;;) {
    int count = proc_listallpids(NULL, 0);
    if (count < 1 || count >= INT_MAX / (int)sizeof(pid_t) - 1) fail("进程清单不可用");
    int capacity = count + 1;
    pid_t *ids = calloc((size_t)capacity, sizeof(pid_t));
    if (!ids) fail("无法分配进程清单");
    int actual = proc_listallpids(ids, capacity * (int)sizeof(pid_t));
    if (actual < 0) { free(ids); fail("进程清单读取失败"); }
    if (actual < capacity) { *length = actual; return ids; }
    free(ids);
  }
}

static Member *session_members(Identity *identity, int *length) {
  verify_leader(identity, 0);
  int count;
  pid_t *ids = process_ids(&count);
  Member *members = calloc((size_t)count + 1, sizeof(Member));
  if (!members) fail("无法分配 session 清单");
  *length = 0;
  for (int i = 0; i < count; i++) {
    if (ids[i] < 1) continue;
    errno = 0;
    pid_t sid = getsid(ids[i]);
    if (sid == -1) { if (errno == ESRCH) continue; fail("无法读取 session 身份"); }
    if (sid != identity->session) continue;
    struct proc_bsdinfo info;
    if (!process_info(ids[i], &info)) continue;
    members[*length].pid = ids[i];
    members[(*length)++].info = info;
  }
  free(ids);
  verify_leader(identity, 0);
  return members;
}

static void signal_members(Identity *identity, Member *members, int count, int signal) {
  for (int i = 0; i < count; i++) {
    pid_t group = (pid_t)members[i].info.pbi_pgid;
    int duplicate = 0;
    for (int j = 0; j < i; j++) if (members[j].info.pbi_pgid == (uint32_t)group) duplicate = 1;
    if (duplicate) continue;
    struct proc_bsdinfo current;
    if (!process_info(members[i].pid, &current)) continue;
    if (current.pbi_start_tvsec != members[i].info.pbi_start_tvsec ||
        current.pbi_start_tvusec != members[i].info.pbi_start_tvusec ||
        getsid(members[i].pid) != identity->session || getpgid(members[i].pid) != group) continue;
    verify_leader(identity, 0);
    if (group < 2 || group == getpgrp()) fail("禁止影响 inspector 自身进程组");
    if (kill(-group, signal) != 0 && errno != ESRCH) fail("无法停止 session 进程组");
  }
}

static void print_members(Identity *identity, Member *members, int count) {
  printf("{\"sessionId\":%d,\"startSec\":%" PRIu64 ",\"startUsec\":%" PRIu64 ",\"members\":[", identity->session, identity->sec, identity->usec);
  for (int i = 0; i < count; i++) {
    struct proc_bsdinfo *info = &members[i].info;
    const char *state = info->pbi_status == SSTOP ? "stopped" : info->pbi_status == SZOMB ? "zombie" : "active";
    printf("%s{\"pid\":%d,\"groupId\":%u,\"startSec\":%" PRIu64 ",\"startUsec\":%" PRIu64 ",\"state\":\"%s\"}", i ? "," : "", members[i].pid, info->pbi_pgid, info->pbi_start_tvsec, info->pbi_start_tvusec, state);
  }
  printf("]}\n");
}

static void write_private(const char *data, size_t length) {
  while (length > 0) {
    ssize_t written = write(3, data, length);
    if (written < 0 && errno == EINTR) continue;
    if (written <= 0) fail("无法写入启动私有通道");
    data += written;
    length -= (size_t)written;
  }
}

static void read_private(void *buffer, size_t length) {
  char *data = buffer;
  while (length > 0) {
    ssize_t received = read(3, data, length);
    if (received < 0 && errno == EINTR) continue;
    if (received <= 0) fail("启动放行帧未完整送达");
    data += received;
    length -= (size_t)received;
  }
}

static int valid_utf8(const unsigned char *data, size_t length) {
  size_t index = 0;
  while (index < length) {
    uint32_t codepoint = data[index++];
    if (codepoint < 0x80) continue;
    int continuation;
    uint32_t minimum;
    if (codepoint >= 0xc2 && codepoint <= 0xdf) {
      continuation = 1; minimum = 0x80; codepoint &= 0x1f;
    } else if (codepoint >= 0xe0 && codepoint <= 0xef) {
      continuation = 2; minimum = 0x800; codepoint &= 0x0f;
    } else if (codepoint >= 0xf0 && codepoint <= 0xf4) {
      continuation = 3; minimum = 0x10000; codepoint &= 0x07;
    } else return 0;
    if ((size_t)continuation > length - index) return 0;
    for (int i = 0; i < continuation; i++) {
      unsigned char next = data[index++];
      if ((next & 0xc0) != 0x80) return 0;
      codepoint = (codepoint << 6) | (next & 0x3f);
    }
    if (codepoint < minimum || codepoint > 0x10ffff ||
        (codepoint >= 0xd800 && codepoint <= 0xdfff)) return 0;
  }
  return 1;
}

static char **read_environment(void) {
  unsigned char header[5];
  read_private(header, sizeof(header));
  if (header[0] != 'R') fail("无效启动放行标记");
  uint32_t length = ((uint32_t)header[1] << 24) | ((uint32_t)header[2] << 16) |
                    ((uint32_t)header[3] << 8) | (uint32_t)header[4];
  long maximum = sysconf(_SC_ARG_MAX);
  if (maximum <= 0 || (uint64_t)length > (uint64_t)maximum)
    fail("启动环境超过系统 ARG_MAX");
  char *payload = malloc((size_t)length + 1);
  if (!payload) fail("无法分配启动环境");
  read_private(payload, length);
  payload[length] = '\0';
  if ((length > 0 && payload[length - 1] != '\0') ||
      !valid_utf8((const unsigned char *)payload, length)) fail("启动环境帧格式无效");
  size_t count = 0;
  for (size_t i = 0; i < length; i++) if (payload[i] == '\0') count++;
  char **environment = calloc(count + 1, sizeof(char *));
  if (!environment) fail("无法分配启动环境条目");
  size_t offset = 0;
  for (size_t i = 0; i < count; i++) {
    char *entry = payload + offset;
    char *equals = strchr(entry, '=');
    if (!equals || equals == entry) fail("启动环境条目必须为非空 key=value");
    environment[i] = entry;
    offset += strlen(entry) + 1;
  }
  return environment;
}

static int launch(int argc, char **argv) {
  if (argc < 3 || argv[2][0] == '\0') fail("缺少启动目标");
  Identity identity = { getpid(), 0, 0 };
  verify_leader(&identity, 1);
  if (getpgrp() != identity.session) fail("启动进程不是 session/进程组 leader");
  int flags = fcntl(3, F_GETFD);
  if (flags == -1 || fcntl(3, F_SETFD, flags | FD_CLOEXEC) == -1)
    fail("无法保护启动私有通道");
  char hello[160];
  int hello_length = snprintf(hello, sizeof(hello),
    "{\"sessionId\":%d,\"startSec\":%" PRIu64 ",\"startUsec\":%" PRIu64 "}\n",
    identity.session, identity.sec, identity.usec);
  if (hello_length < 0 || (size_t)hello_length >= sizeof(hello)) fail("无法编码启动身份");
  write_private(hello, (size_t)hello_length);
  char **environment = read_environment();
  /* 完整私有帧校验之前不应用目标环境，目标凭据不会出现在 wrapper argv。 */
  environ = environment;
  const char released[] = "{\"released\":true}\n";
  write_private(released, sizeof(released) - 1);
  execvp(argv[2], argv + 2);
  int exec_errno = errno;
  char error[80];
  int error_length = snprintf(error, sizeof(error), "{\"exec_failed\":%d}\n", exec_errno);
  if (error_length > 0 && (size_t)error_length < sizeof(error))
    write_private(error, (size_t)error_length);
  return 127;
}

int main(int argc, char **argv) {
  if (argc >= 2 && strcmp(argv[1], "launch") == 0) return launch(argc, argv);
  if (argc != 5 && argc != 6) fail("无效调用参数");
  long pid = strtol(argv[2], NULL, 10);
  if (pid < 2 || pid > INT_MAX) fail("无效 leader PID");
  Identity identity = { (pid_t)pid, strtoull(argv[3], NULL, 10), strtoull(argv[4], NULL, 10) };
  int initial = strcmp(argv[1], "open") == 0;
  if (!initial && strcmp(argv[1], "scan") != 0 && strcmp(argv[1], "signal") != 0) fail("无效操作");
  verify_leader(&identity, initial);
  int count;
  Member *members = session_members(&identity, &count);
  if (strcmp(argv[1], "signal") == 0) {
    if (argc != 6) fail("缺少信号");
    int signal = atoi(argv[5]);
    if (signal != SIGSTOP && signal != SIGCONT && signal != SIGTERM && signal != SIGKILL) fail("不支持的信号");
    signal_members(&identity, members, count, signal);
  }
  print_members(&identity, members, count);
  free(members);
  return 0;
}
