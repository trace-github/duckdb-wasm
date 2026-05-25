/*
 * WasmFS + OPFS Feasibility Test
 *
 * Standalone C program that exercises POSIX file operations through
 * Emscripten's WasmFS with the OPFS backend. Tests the exact file
 * access patterns DuckDB uses (sequential writes, random reads,
 * truncate, multiple simultaneous files, persistence, threading).
 *
 * Build with: emcc wasmfs_test.c -sWASMFS -lopfs.js -pthread ...
 * Run in browser with COI headers (see test-rig/).
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <time.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/stat.h>

#include <emscripten/wasmfs.h>

#ifdef __EMSCRIPTEN_PTHREADS__
#include <pthread.h>
#endif

/* ---------- Helpers ---------- */

#define OPFS_MOUNT "/opfs"
#define KB 1024
#define MB (1024 * 1024)

static int test_pass = 0;
static int test_fail = 0;

/* JSON output buffer */
static char json_buf[16384];
static int json_pos = 0;
static int json_count = 0;

static void json_start(void) {
    json_pos = 0;
    json_pos += snprintf(json_buf + json_pos, sizeof(json_buf) - json_pos, "{\"tests\":[");
}

static void json_add(const char *name, const char *status, double metric, const char *unit, const char *detail) {
    if (json_count > 0) {
        json_pos += snprintf(json_buf + json_pos, sizeof(json_buf) - json_pos, ",");
    }
    json_count++;
    json_pos += snprintf(json_buf + json_pos, sizeof(json_buf) - json_pos,
        "{\"name\":\"%s\",\"status\":\"%s\"", name, status);
    if (metric >= 0) {
        json_pos += snprintf(json_buf + json_pos, sizeof(json_buf) - json_pos,
            ",\"metric\":%.2f,\"unit\":\"%s\"", metric, unit);
    }
    if (detail && detail[0]) {
        json_pos += snprintf(json_buf + json_pos, sizeof(json_buf) - json_pos,
            ",\"detail\":\"%s\"", detail);
    }
    json_pos += snprintf(json_buf + json_pos, sizeof(json_buf) - json_pos, "}");
}

static void json_end(void) {
    json_pos += snprintf(json_buf + json_pos, sizeof(json_buf) - json_pos,
        "],\"pass\":%d,\"fail\":%d,\"status\":\"%s\"}",
        test_pass, test_fail, test_fail == 0 ? "PASS" : "FAIL");
}

static void pass(const char *name, double metric, const char *unit) {
    test_pass++;
    printf("[PASS] %s", name);
    if (metric >= 0) printf(" (%.2f %s)", metric, unit);
    printf("\n");
    json_add(name, "PASS", metric, unit, "");
}

static void fail(const char *name, const char *detail) {
    test_fail++;
    printf("[FAIL] %s: %s\n", name, detail);
    json_add(name, "FAIL", -1, "", detail);
}

/* Clock helper (monotonic if available) */
static double now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec * 1000.0 + ts.tv_nsec / 1e6;
}

/* ---------- Test 1: Mount OPFS ---------- */

static int test_mount_opfs(void) {
    printf("\n--- Test: Mount OPFS ---\n");

    backend_t opfs = wasmfs_create_opfs_backend();
    if (!opfs) {
        fail("mount_opfs", "wasmfs_create_opfs_backend() returned NULL");
        return -1;
    }

    int rc = wasmfs_create_directory(OPFS_MOUNT, 0777, opfs);
    if (rc != 0) {
        char detail[128];
        snprintf(detail, sizeof(detail), "wasmfs_create_directory failed: errno=%d (%s)", errno, strerror(errno));
        fail("mount_opfs", detail);
        return -1;
    }

    pass("mount_opfs", -1, "");
    return 0;
}

/* ---------- Test 2: Create + Write ---------- */

static int test_create_write(void) {
    printf("\n--- Test: Create + Write (1 MB) ---\n");

    const char *path = OPFS_MOUNT "/test_write.bin";
    const int total = 1 * MB;
    const int chunk = 4 * KB;

    FILE *f = fopen(path, "wb");
    if (!f) {
        char detail[128];
        snprintf(detail, sizeof(detail), "fopen failed: %s", strerror(errno));
        fail("create_write", detail);
        return -1;
    }

    /* Write 1MB of patterned data */
    unsigned char buf[4096];
    int written = 0;
    while (written < total) {
        int sz = (total - written < chunk) ? (total - written) : chunk;
        for (int i = 0; i < sz; i++) buf[i] = (unsigned char)((written + i) & 0xFF);
        size_t n = fwrite(buf, 1, sz, f);
        if ((int)n != sz) {
            char detail[128];
            snprintf(detail, sizeof(detail), "fwrite short: wrote %d of %d at offset %d", (int)n, sz, written);
            fail("create_write", detail);
            fclose(f);
            return -1;
        }
        written += sz;
    }

    fclose(f);

    /* Verify file size */
    struct stat st;
    if (stat(path, &st) != 0 || st.st_size != total) {
        char detail[128];
        snprintf(detail, sizeof(detail), "stat: expected %d bytes, got %lld", total, (long long)st.st_size);
        fail("create_write", detail);
        return -1;
    }

    pass("create_write", (double)total / MB, "MB");
    return 0;
}

/* ---------- Test 3: Reopen + Read + Verify ---------- */

static int test_reopen_read(void) {
    printf("\n--- Test: Reopen + Read + Verify ---\n");

    const char *path = OPFS_MOUNT "/test_write.bin";
    const int total = 1 * MB;
    const int chunk = 4 * KB;

    FILE *f = fopen(path, "rb");
    if (!f) {
        char detail[128];
        snprintf(detail, sizeof(detail), "fopen(rb) failed: %s", strerror(errno));
        fail("reopen_read", detail);
        return -1;
    }

    unsigned char buf[4096];
    int offset = 0;
    while (offset < total) {
        int sz = (total - offset < chunk) ? (total - offset) : chunk;
        size_t n = fread(buf, 1, sz, f);
        if ((int)n != sz) {
            char detail[128];
            snprintf(detail, sizeof(detail), "fread short: got %d of %d at offset %d", (int)n, sz, offset);
            fail("reopen_read", detail);
            fclose(f);
            return -1;
        }
        for (int i = 0; i < sz; i++) {
            if (buf[i] != (unsigned char)((offset + i) & 0xFF)) {
                char detail[128];
                snprintf(detail, sizeof(detail), "data mismatch at byte %d: expected 0x%02x got 0x%02x",
                    offset + i, (offset + i) & 0xFF, buf[i]);
                fail("reopen_read", detail);
                fclose(f);
                return -1;
            }
        }
        offset += sz;
    }

    fclose(f);
    pass("reopen_read", (double)total / MB, "MB verified");
    return 0;
}

/* ---------- Test 4: Sequential Write Throughput ---------- */

static int test_seq_write_throughput(void) {
    printf("\n--- Test: Sequential Write Throughput (10 MB) ---\n");

    const char *path = OPFS_MOUNT "/test_throughput.bin";
    const int total = 10 * MB;
    const int chunk = 4 * KB;

    unsigned char buf[4096];
    memset(buf, 0xAB, sizeof(buf));

    FILE *f = fopen(path, "wb");
    if (!f) {
        fail("seq_write_throughput", strerror(errno));
        return -1;
    }

    double t0 = now_ms();
    int written = 0;
    while (written < total) {
        int sz = (total - written < chunk) ? (total - written) : chunk;
        size_t n = fwrite(buf, 1, sz, f);
        if ((int)n != sz) {
            fail("seq_write_throughput", "short write");
            fclose(f);
            return -1;
        }
        written += sz;
    }
    fflush(f);
    fclose(f);
    double elapsed = now_ms() - t0;

    double mbps = (total / (double)MB) / (elapsed / 1000.0);
    pass("seq_write_throughput", mbps, "MB/s");
    return 0;
}

/* ---------- Test 5: Random Read ---------- */

static int test_random_read(void) {
    printf("\n--- Test: Random Read (1000 x 4KB) ---\n");

    const char *path = OPFS_MOUNT "/test_throughput.bin";
    const int file_size = 10 * MB;
    const int chunk = 4 * KB;
    const int iters = 1000;

    int fd = open(path, O_RDONLY);
    if (fd < 0) {
        fail("random_read", strerror(errno));
        return -1;
    }

    unsigned char buf[4096];
    /* Simple LCG for deterministic positions */
    unsigned int seed = 12345;

    double t0 = now_ms();
    for (int i = 0; i < iters; i++) {
        seed = seed * 1103515245 + 12345;
        off_t pos = (seed % (file_size - chunk));
        pos &= ~3; /* align to 4 bytes */
        if (lseek(fd, pos, SEEK_SET) != pos) {
            fail("random_read", "lseek failed");
            close(fd);
            return -1;
        }
        ssize_t n = read(fd, buf, chunk);
        if (n != chunk) {
            char detail[128];
            snprintf(detail, sizeof(detail), "short read: %zd at offset %lld", n, (long long)pos);
            fail("random_read", detail);
            close(fd);
            return -1;
        }
    }
    double elapsed = now_ms() - t0;
    close(fd);

    double iops = iters / (elapsed / 1000.0);
    pass("random_read", iops, "IOPS (4KB)");
    return 0;
}

/* ---------- Test 6: Truncate ---------- */

static int test_truncate(void) {
    printf("\n--- Test: Truncate ---\n");

    const char *path = OPFS_MOUNT "/test_truncate.bin";

    /* Create a 64KB file */
    FILE *f = fopen(path, "wb");
    if (!f) { fail("truncate", "create failed"); return -1; }
    unsigned char buf[4096];
    memset(buf, 0xCC, sizeof(buf));
    for (int i = 0; i < 16; i++) fwrite(buf, 1, 4096, f);
    fclose(f);

    struct stat st;
    stat(path, &st);
    if (st.st_size != 64 * KB) {
        char detail[128];
        snprintf(detail, sizeof(detail), "initial size: %lld (expected %d)", (long long)st.st_size, 64 * KB);
        fail("truncate", detail);
        return -1;
    }

    /* Truncate to 16KB */
    if (truncate(path, 16 * KB) != 0) {
        char detail[128];
        snprintf(detail, sizeof(detail), "truncate failed: %s", strerror(errno));
        fail("truncate", detail);
        return -1;
    }

    stat(path, &st);
    if (st.st_size != 16 * KB) {
        char detail[128];
        snprintf(detail, sizeof(detail), "after truncate: %lld (expected %d)", (long long)st.st_size, 16 * KB);
        fail("truncate", detail);
        return -1;
    }

    /* Truncate to 0 */
    if (truncate(path, 0) != 0) {
        fail("truncate", "truncate to 0 failed");
        return -1;
    }

    stat(path, &st);
    if (st.st_size != 0) {
        fail("truncate", "file not empty after truncate to 0");
        return -1;
    }

    pass("truncate", -1, "");
    return 0;
}

/* ---------- Test 7: Multiple Files (WAL + DB pattern) ---------- */

static int test_multiple_files(void) {
    printf("\n--- Test: Multiple Simultaneous Files ---\n");

    const char *path_db  = OPFS_MOUNT "/test_multi_db.bin";
    const char *path_wal = OPFS_MOUNT "/test_multi_wal.bin";

    FILE *fdb = fopen(path_db, "wb");
    FILE *fwal = fopen(path_wal, "wb");
    if (!fdb || !fwal) {
        fail("multiple_files", "failed to open both files");
        if (fdb) fclose(fdb);
        if (fwal) fclose(fwal);
        return -1;
    }

    /* Interleaved writes */
    unsigned char db_data[4096], wal_data[4096];
    memset(db_data, 0xDB, sizeof(db_data));
    memset(wal_data, 0xAA, sizeof(wal_data));

    for (int i = 0; i < 100; i++) {
        if (fwrite(db_data, 1, 4096, fdb) != 4096) {
            fail("multiple_files", "db write failed");
            fclose(fdb); fclose(fwal);
            return -1;
        }
        if (fwrite(wal_data, 1, 4096, fwal) != 4096) {
            fail("multiple_files", "wal write failed");
            fclose(fdb); fclose(fwal);
            return -1;
        }
    }

    fclose(fdb);
    fclose(fwal);

    /* Verify sizes */
    struct stat st;
    stat(path_db, &st);
    if (st.st_size != 100 * 4096) {
        fail("multiple_files", "db file size wrong");
        return -1;
    }
    stat(path_wal, &st);
    if (st.st_size != 100 * 4096) {
        fail("multiple_files", "wal file size wrong");
        return -1;
    }

    pass("multiple_files", 2.0, "files");
    return 0;
}

/* ---------- Test 8: Persistence (close + reopen) ---------- */

static int test_persistence(void) {
    printf("\n--- Test: Persistence (close + reopen) ---\n");

    const char *path = OPFS_MOUNT "/test_persist.bin";

    /* Write known data */
    FILE *f = fopen(path, "wb");
    if (!f) { fail("persistence", "create failed"); return -1; }
    const char *magic = "WASMFS_PERSIST_TEST_12345678";
    fwrite(magic, 1, strlen(magic), f);
    fclose(f);

    /* Reopen and verify */
    f = fopen(path, "rb");
    if (!f) {
        fail("persistence", "reopen failed");
        return -1;
    }
    char buf[64] = {0};
    size_t n = fread(buf, 1, strlen(magic), f);
    fclose(f);

    if (n != strlen(magic) || memcmp(buf, magic, strlen(magic)) != 0) {
        char detail[128];
        snprintf(detail, sizeof(detail), "data mismatch: got '%s'", buf);
        fail("persistence", detail);
        return -1;
    }

    pass("persistence", -1, "");
    return 0;
}

/* ---------- Test 9: Threading ---------- */

#ifdef __EMSCRIPTEN_PTHREADS__

#define THREAD_WRITES 16
#define THREAD_CHUNK 4096

typedef struct {
    int id;
    int ok;
    char error[128];
} thread_arg_t;

static void *thread_worker(void *arg) {
    thread_arg_t *ta = (thread_arg_t *)arg;
    char path[128];
    snprintf(path, sizeof(path), OPFS_MOUNT "/test_thread_%d.bin", ta->id);

    FILE *f = fopen(path, "wb");
    if (!f) {
        snprintf(ta->error, sizeof(ta->error), "fopen failed: %s", strerror(errno));
        ta->ok = 0;
        return NULL;
    }

    unsigned char buf[THREAD_CHUNK];
    memset(buf, (unsigned char)(ta->id & 0xFF), sizeof(buf));

    for (int i = 0; i < THREAD_WRITES; i++) {
        if (fwrite(buf, 1, THREAD_CHUNK, f) != THREAD_CHUNK) {
            snprintf(ta->error, sizeof(ta->error), "fwrite failed at iter %d", i);
            ta->ok = 0;
            fclose(f);
            return NULL;
        }
    }
    fclose(f);

    /* Verify */
    f = fopen(path, "rb");
    if (!f) {
        snprintf(ta->error, sizeof(ta->error), "reopen failed: %s", strerror(errno));
        ta->ok = 0;
        return NULL;
    }

    struct stat st;
    stat(path, &st);
    if (st.st_size != THREAD_WRITES * THREAD_CHUNK) {
        snprintf(ta->error, sizeof(ta->error), "size mismatch: %lld vs %d",
            (long long)st.st_size, THREAD_WRITES * THREAD_CHUNK);
        ta->ok = 0;
        fclose(f);
        return NULL;
    }

    /* Spot-check first chunk */
    size_t n = fread(buf, 1, THREAD_CHUNK, f);
    fclose(f);
    if ((int)n != THREAD_CHUNK) {
        snprintf(ta->error, sizeof(ta->error), "read short: %d", (int)n);
        ta->ok = 0;
        return NULL;
    }
    for (int i = 0; i < THREAD_CHUNK; i++) {
        if (buf[i] != (unsigned char)(ta->id & 0xFF)) {
            snprintf(ta->error, sizeof(ta->error), "data mismatch at byte %d", i);
            ta->ok = 0;
            return NULL;
        }
    }

    ta->ok = 1;
    return NULL;
}

/* Test 9a: Single pthread doing OPFS I/O (verifies threads can access OPFS at all) */
static int test_single_thread_opfs(void) {
    printf("\n--- Test: Single pthread OPFS I/O ---\n");

    pthread_t thread;
    thread_arg_t arg;
    arg.id = 99;
    arg.ok = 0;
    arg.error[0] = '\0';

    int rc = pthread_create(&thread, NULL, thread_worker, &arg);
    if (rc != 0) {
        char detail[128];
        snprintf(detail, sizeof(detail), "pthread_create failed: %d", rc);
        fail("single_thread_opfs", detail);
        return -1;
    }

    pthread_join(thread, NULL);

    if (!arg.ok) {
        char detail[128];
        snprintf(detail, sizeof(detail), "thread failed: %s", arg.error);
        fail("single_thread_opfs", detail);
        return -1;
    }

    pass("single_thread_opfs", (double)(THREAD_WRITES * THREAD_CHUNK) / KB, "KB written+verified");
    return 0;
}

/* Test 9b: Two pthreads writing different files concurrently */
static int test_two_threads_opfs(void) {
    printf("\n--- Test: Two concurrent pthreads OPFS I/O ---\n");

    pthread_t threads[2];
    thread_arg_t args[2];

    for (int i = 0; i < 2; i++) {
        args[i].id = i;
        args[i].ok = 0;
        args[i].error[0] = '\0';
        int rc = pthread_create(&threads[i], NULL, thread_worker, &args[i]);
        if (rc != 0) {
            char detail[128];
            snprintf(detail, sizeof(detail), "pthread_create failed: %d", rc);
            fail("two_threads_opfs", detail);
            return -1;
        }
    }

    for (int i = 0; i < 2; i++) {
        pthread_join(threads[i], NULL);
    }

    int all_ok = 1;
    for (int i = 0; i < 2; i++) {
        if (!args[i].ok) {
            char detail[128];
            snprintf(detail, sizeof(detail), "thread %d failed: %s", i, args[i].error);
            fail("two_threads_opfs", detail);
            all_ok = 0;
        }
    }

    if (all_ok) {
        pass("two_threads_opfs", 2.0, "threads OK");
    }
    return all_ok ? 0 : -1;
}

/* Test 9c: Four pthreads writing different files concurrently */
static int test_four_threads_opfs(void) {
    printf("\n--- Test: Four concurrent pthreads OPFS I/O ---\n");

    pthread_t threads[4];
    thread_arg_t args[4];

    for (int i = 0; i < 4; i++) {
        args[i].id = i;
        args[i].ok = 0;
        args[i].error[0] = '\0';
        int rc = pthread_create(&threads[i], NULL, thread_worker, &args[i]);
        if (rc != 0) {
            char detail[128];
            snprintf(detail, sizeof(detail), "pthread_create failed: %d", rc);
            fail("four_threads_opfs", detail);
            return -1;
        }
    }

    for (int i = 0; i < 4; i++) {
        pthread_join(threads[i], NULL);
    }

    int all_ok = 1;
    for (int i = 0; i < 4; i++) {
        if (!args[i].ok) {
            char detail[128];
            snprintf(detail, sizeof(detail), "thread %d failed: %s", i, args[i].error);
            fail("four_threads_opfs", detail);
            all_ok = 0;
        }
    }

    if (all_ok) {
        pass("four_threads_opfs", 4.0, "threads OK");
    }
    return all_ok ? 0 : -1;
}

#endif /* __EMSCRIPTEN_PTHREADS__ */

/* ---------- Cleanup ---------- */

static void cleanup_files(void) {
    const char *files[] = {
        OPFS_MOUNT "/test_write.bin",
        OPFS_MOUNT "/test_throughput.bin",
        OPFS_MOUNT "/test_truncate.bin",
        OPFS_MOUNT "/test_multi_db.bin",
        OPFS_MOUNT "/test_multi_wal.bin",
        OPFS_MOUNT "/test_persist.bin",
#ifdef __EMSCRIPTEN_PTHREADS__
        OPFS_MOUNT "/test_thread_0.bin",
        OPFS_MOUNT "/test_thread_1.bin",
        OPFS_MOUNT "/test_thread_2.bin",
        OPFS_MOUNT "/test_thread_3.bin",
        OPFS_MOUNT "/test_thread_99.bin",
#endif
    };
    int n = sizeof(files) / sizeof(files[0]);
    for (int i = 0; i < n; i++) {
        unlink(files[i]);
    }
}

/* ---------- Main ---------- */

int main(void) {
    printf("WasmFS + OPFS Feasibility Test\n");
    printf("==============================\n");

    json_start();

    /* Test 1: Mount */
    if (test_mount_opfs() != 0) {
        printf("\nMount failed — cannot proceed with remaining tests.\n");
        json_end();
        printf("\n__JSON_RESULT__%s__JSON_END__\n", json_buf);
        return 1;
    }

    /* Tests 2-8: File operations */
    test_create_write();
    test_reopen_read();
    test_seq_write_throughput();
    test_random_read();
    test_truncate();
    test_multiple_files();
    test_persistence();

#ifdef __EMSCRIPTEN_PTHREADS__
    test_single_thread_opfs();
    test_two_threads_opfs();
    test_four_threads_opfs();
#else
    printf("\n--- Test: Threading (SKIPPED - no pthreads) ---\n");
    json_add("threading", "SKIP", -1, "", "compiled without pthreads");
#endif

    /* Cleanup */
    cleanup_files();

    /* Summary */
    json_end();
    printf("\n==============================\n");
    printf("Results: %d passed, %d failed\n", test_pass, test_fail);
    printf("\n__JSON_RESULT__%s__JSON_END__\n", json_buf);

    return test_fail > 0 ? 1 : 0;
}
