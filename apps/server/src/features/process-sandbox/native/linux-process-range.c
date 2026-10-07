#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/nsfs.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

typedef struct { pid_t pid, ppid, group; char state; unsigned long long birth; ino_t ns; bool init; } Member;
static Member *members;
static size_t count, capacity;
static void fail(const char *message) { fprintf(stderr, "%s: %s\n", message, strerror(errno)); exit(2); }
static bool read_member(pid_t pid, Member *result) {
  // /proc paths contain only a kernel PID plus fixed suffix; buffer is a protocol implementation detail.
  char path[128], *line = NULL; size_t size = 0;
  snprintf(path, sizeof(path), "/proc/%d/stat", pid);
  FILE *file = fopen(path, "r"); if (!file) return false;
  ssize_t length = getline(&line, &size, file); fclose(file);
  char *fields = length > 0 ? strrchr(line, ')') : NULL;
  if (!fields || fields[1] != ' ') { free(line); return false; }
  Member m = {.pid = pid}; char *context = NULL;
  char *word = strtok_r(fields + 2, " ", &context);
  for (int field = 3; word && field <= 22; field++, word = strtok_r(NULL, " ", &context)) {
    if (field == 3) m.state = word[0];
    else if (field == 4) m.ppid = (pid_t)strtol(word, NULL, 10);
    else if (field == 5) m.group = (pid_t)strtol(word, NULL, 10);
    else if (field == 22) m.birth = strtoull(word, NULL, 10);
  }
  free(line); if (!m.birth) return false;
  snprintf(path, sizeof(path), "/proc/%d/ns/pid", pid);
  struct stat st; if (stat(path, &st)) return false; m.ns = st.st_ino;
  snprintf(path, sizeof(path), "/proc/%d/status", pid);
  file = fopen(path, "r"); if (!file) return false;
  line = NULL; size = 0;
  while (getline(&line, &size, file) > 0) {
    if (strncmp(line, "NSpid:", 6)) continue;
    char *token = strtok_r(line + 6, " \t\n", &context); long last = 0;
    while (token) { last = strtol(token, NULL, 10); token = strtok_r(NULL, " \t\n", &context); }
    m.init = last == 1; break;
  }
  free(line); fclose(file); *result = m; return true;
}
static bool namespace_within(pid_t pid, ino_t target) {
  char path[128]; snprintf(path, sizeof(path), "/proc/%d/ns/pid", pid);
  int fd = open(path, O_RDONLY | O_CLOEXEC); if (fd < 0) return false;
  for (;;) {
    struct stat st; if (fstat(fd, &st)) { close(fd); fail("namespace stat"); }
    if (st.st_ino == target) { close(fd); return true; }
    int parent = ioctl(fd, NS_GET_PARENT); close(fd);
    if (parent < 0) { if (errno == EPERM || errno == ENOENT) return false; fail("namespace parent"); }
    fd = parent;
  }
}
static void collect(void) {
  DIR *directory = opendir("/proc"); if (!directory) fail("proc scan");
  struct dirent *entry;
  while ((entry = readdir(directory))) {
    char *end; long pid = strtol(entry->d_name, &end, 10); if (*end || pid < 1) continue;
    Member m; if (!read_member((pid_t)pid, &m)) continue;
    if (count == capacity) { capacity = capacity ? capacity * 2 : 64; members = realloc(members, capacity * sizeof(Member)); if (!members) fail("scan allocation"); }
    members[count++] = m;
  }
  closedir(directory);
}
static size_t distance_from(Member m, pid_t leader) {
  size_t depth = 0;
  while (m.ppid > 1) {
    depth++;
    if (m.ppid == leader) return depth;
    bool found = false;
    for (size_t index = 0; index < count; index++) if (members[index].pid == m.ppid) { m = members[index]; found = true; break; }
    if (!found) return 0;
  }
  return 0;
}
static void send_member(Member m, int signal_number) {
  if (m.state == 'Z') return;
  int fd = (int)syscall(SYS_pidfd_open, m.pid, 0);
  if (fd < 0) {
    int failure = errno; Member current;
    if (failure == ESRCH || (failure == EINVAL && (!read_member(m.pid, &current) || current.birth != m.birth || current.state == 'Z'))) return;
    errno = failure; fail("pidfd open");
  }
  Member current;
  if (!read_member(m.pid, &current) || current.birth != m.birth || current.ns != m.ns) { close(fd); return; }
  if (syscall(SYS_pidfd_send_signal, fd, signal_number, NULL, 0) && errno != ESRCH) { close(fd); fail("pidfd signal"); }
  close(fd);
}
int main(int argc, char **argv) {
  if (argc < 3) { errno = EINVAL; fail("arguments"); }
  collect();
  if (!strcmp(argv[1], "open")) {
    pid_t leader = (pid_t)strtol(argv[2], NULL, 10); Member root;
    if (!read_member(leader, &root)) { puts("{\"gone\":true}"); return 0; }
    Member selected = {0}; size_t nearest = SIZE_MAX;
    for (size_t index = 0; index < count; index++) {
      Member m = members[index]; size_t depth = distance_from(m, leader);
      if (m.ns == root.ns || !m.init || !depth || depth >= nearest) continue;
      selected = m; nearest = depth;
    }
    if (selected.pid) printf("{\"namespacePid\":%d,\"namespaceIno\":%llu,\"leaderBirth\":%llu}\n", selected.pid, (unsigned long long)selected.ns, root.birth);
    else printf("{\"pending\":true,\"leaderBirth\":%llu}\n", root.birth);
    return 0;
  }
  int fd = open(argv[2], O_RDONLY | O_CLOEXEC); if (fd < 0) fail("range namespace");
  struct stat root; if (fstat(fd, &root)) fail("range identity"); close(fd);
  int signal_number = argc > 3 ? (int)strtol(argv[3], NULL, 10) : 0;
  bool *included = calloc(count, sizeof(bool)); if (!included) fail("range allocation");
  for (size_t index = 0; index < count; index++) included[index] = namespace_within(members[index].pid, root.st_ino);
  size_t member_count = 0, active_count = 0;
  for (size_t index = 0; index < count; index++) {
    if (!included[index]) continue;
    Member m = members[index]; bool leaf = !m.init;
    for (size_t child = 0; child < count && leaf; child++) if (included[child] && members[child].ppid == m.pid && members[child].state != 'Z') leaf = false;
    if (signal_number && (signal_number != SIGTERM || leaf)) send_member(m, signal_number);
    member_count++;
    if (m.state != 'Z' && m.state != 'T' && m.state != 't') active_count++;
  }
  // Fixed numeric control fields: user display/capture limits never truncate range evidence.
  printf("{\"memberCount\":%zu,\"activeCount\":%zu}\n", member_count, active_count);
  free(included); free(members); return 0;
}
