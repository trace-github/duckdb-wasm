#ifdef DUCKDB_WASMFS

#include "duckdb/web/io/wasmfs_filesystem.h"

#include <cerrno>
#include <cstring>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

namespace duckdb {
namespace web {
namespace io {

static constexpr const char *OPFS_PREFIX = "opfs://";
static constexpr size_t OPFS_PREFIX_LEN = 7;
static constexpr const char *OPFS_MOUNT = "/opfs/";

// --- WasmFSFileHandle ---

WasmFSFileHandle::WasmFSFileHandle(FileSystem &file_system, string path, FileOpenFlags flags, int fd)
    : FileHandle(file_system, std::move(path), flags), fd(fd) {}

WasmFSFileHandle::~WasmFSFileHandle() {
    Close();
}

void WasmFSFileHandle::Close() {
    if (fd >= 0) {
        ::close(fd);
        fd = -1;
    }
}

// --- WasmFSFileSystem ---

string WasmFSFileSystem::TranslatePath(const string &path) {
    if (path.compare(0, OPFS_PREFIX_LEN, OPFS_PREFIX) == 0) {
        return string(OPFS_MOUNT) + path.substr(OPFS_PREFIX_LEN);
    }
    return path;
}

bool WasmFSFileSystem::CanHandleFile(const string &fpath) {
    return fpath.compare(0, OPFS_PREFIX_LEN, OPFS_PREFIX) == 0;
}

unique_ptr<FileHandle> WasmFSFileSystem::OpenFile(const string &path, FileOpenFlags flags,
                                                   optional_ptr<FileOpener> opener) {
    auto translated = TranslatePath(path);

    // NULL_IF_NOT_EXISTS: check access first, return nullptr if absent
    if (flags.ReturnNullIfNotExists()) {
        if (::access(translated.c_str(), F_OK) != 0) {
            return nullptr;
        }
    }

    int posix_flags = 0;
    if (flags.OpenForReading() && flags.OpenForWriting()) {
        posix_flags = O_RDWR;
    } else if (flags.OpenForWriting()) {
        posix_flags = O_WRONLY;
    } else {
        posix_flags = O_RDONLY;
    }

    if (flags.CreateFileIfNotExists() || flags.OverwriteExistingFile()) {
        posix_flags |= O_CREAT;
    }
    if (flags.OverwriteExistingFile()) {
        posix_flags |= O_TRUNC;
    }
    if (flags.OpenForAppending()) {
        posix_flags |= O_APPEND;
    }

    int fd = ::open(translated.c_str(), posix_flags, 0666);
    if (fd < 0) {
        if (flags.ReturnNullIfNotExists() && errno == ENOENT) {
            return nullptr;
        }
        throw IOException("WasmFSFileSystem: failed to open file '%s': %s", path, strerror(errno));
    }

    return make_uniq<WasmFSFileHandle>(*this, path, flags, fd);
}

void WasmFSFileSystem::Read(FileHandle &handle, void *buffer, int64_t nr_bytes, idx_t location) {
    auto &wfs_handle = handle.Cast<WasmFSFileHandle>();
    auto bytes_read = ::pread(wfs_handle.fd, buffer, nr_bytes, location);
    if (bytes_read < 0) {
        throw IOException("WasmFSFileSystem: read failed on '%s': %s", handle.path, strerror(errno));
    }
    if (bytes_read != nr_bytes) {
        throw IOException("WasmFSFileSystem: short read on '%s': expected %lld, got %lld",
                          handle.path, (long long)nr_bytes, (long long)bytes_read);
    }
}

int64_t WasmFSFileSystem::Read(FileHandle &handle, void *buffer, int64_t nr_bytes) {
    auto &wfs_handle = handle.Cast<WasmFSFileHandle>();
    auto bytes_read = ::read(wfs_handle.fd, buffer, nr_bytes);
    if (bytes_read < 0) {
        throw IOException("WasmFSFileSystem: read failed on '%s': %s", handle.path, strerror(errno));
    }
    return bytes_read;
}

void WasmFSFileSystem::Write(FileHandle &handle, void *buffer, int64_t nr_bytes, idx_t location) {
    auto &wfs_handle = handle.Cast<WasmFSFileHandle>();
    auto bytes_written = ::pwrite(wfs_handle.fd, buffer, nr_bytes, location);
    if (bytes_written < 0) {
        throw IOException("WasmFSFileSystem: write failed on '%s': %s", handle.path, strerror(errno));
    }
    if (bytes_written != nr_bytes) {
        throw IOException("WasmFSFileSystem: short write on '%s': expected %lld, wrote %lld",
                          handle.path, (long long)nr_bytes, (long long)bytes_written);
    }
}

int64_t WasmFSFileSystem::Write(FileHandle &handle, void *buffer, int64_t nr_bytes) {
    auto &wfs_handle = handle.Cast<WasmFSFileHandle>();
    auto bytes_written = ::write(wfs_handle.fd, buffer, nr_bytes);
    if (bytes_written < 0) {
        throw IOException("WasmFSFileSystem: write failed on '%s': %s", handle.path, strerror(errno));
    }
    return bytes_written;
}

int64_t WasmFSFileSystem::GetFileSize(FileHandle &handle) {
    auto &wfs_handle = handle.Cast<WasmFSFileHandle>();
    struct stat st;
    if (::fstat(wfs_handle.fd, &st) != 0) {
        throw IOException("WasmFSFileSystem: fstat failed on '%s': %s", handle.path, strerror(errno));
    }
    return st.st_size;
}

timestamp_t WasmFSFileSystem::GetLastModifiedTime(FileHandle &handle) {
    auto &wfs_handle = handle.Cast<WasmFSFileHandle>();
    struct stat st;
    if (::fstat(wfs_handle.fd, &st) != 0) {
        throw IOException("WasmFSFileSystem: fstat failed on '%s': %s", handle.path, strerror(errno));
    }
    return timestamp_t(static_cast<int64_t>(st.st_mtime) * 1000000);
}

bool WasmFSFileSystem::FileExists(const string &filename, optional_ptr<FileOpener> opener) {
    auto translated = TranslatePath(filename);
    return ::access(translated.c_str(), F_OK) == 0;
}

void WasmFSFileSystem::RemoveFile(const string &filename, optional_ptr<FileOpener> opener) {
    auto translated = TranslatePath(filename);
    if (::unlink(translated.c_str()) != 0) {
        throw IOException("WasmFSFileSystem: failed to remove '%s': %s", filename, strerror(errno));
    }
}

void WasmFSFileSystem::MoveFile(const string &source, const string &target,
                                 optional_ptr<FileOpener> opener) {
    auto src = TranslatePath(source);
    auto dst = TranslatePath(target);
    if (::rename(src.c_str(), dst.c_str()) != 0) {
        throw IOException("WasmFSFileSystem: failed to rename '%s' to '%s': %s",
                          source, target, strerror(errno));
    }
}

void WasmFSFileSystem::Truncate(FileHandle &handle, int64_t new_size) {
    auto &wfs_handle = handle.Cast<WasmFSFileHandle>();
    if (::ftruncate(wfs_handle.fd, new_size) != 0) {
        throw IOException("WasmFSFileSystem: truncate failed on '%s': %s", handle.path, strerror(errno));
    }
}

void WasmFSFileSystem::Seek(FileHandle &handle, idx_t location) {
    auto &wfs_handle = handle.Cast<WasmFSFileHandle>();
    if (::lseek(wfs_handle.fd, static_cast<off_t>(location), SEEK_SET) < 0) {
        throw IOException("WasmFSFileSystem: seek failed on '%s': %s", handle.path, strerror(errno));
    }
}

void WasmFSFileSystem::Reset(FileHandle &handle) {
    Seek(handle, 0);
}

idx_t WasmFSFileSystem::SeekPosition(FileHandle &handle) {
    auto &wfs_handle = handle.Cast<WasmFSFileHandle>();
    auto pos = ::lseek(wfs_handle.fd, 0, SEEK_CUR);
    if (pos < 0) {
        throw IOException("WasmFSFileSystem: seek position failed on '%s': %s", handle.path, strerror(errno));
    }
    return static_cast<idx_t>(pos);
}

void WasmFSFileSystem::FileSync(FileHandle &handle) {
    auto &wfs_handle = handle.Cast<WasmFSFileHandle>();
    if (::fsync(wfs_handle.fd) != 0) {
        throw IOException("WasmFSFileSystem: fsync failed on '%s': %s", handle.path, strerror(errno));
    }
}

vector<OpenFileInfo> WasmFSFileSystem::Glob(const string &path, FileOpener *opener) {
    vector<OpenFileInfo> result;
    if (FileExists(path)) {
        result.emplace_back(path);
    }
    return result;
}

}  // namespace io
}  // namespace web
}  // namespace duckdb

#endif  // DUCKDB_WASMFS
