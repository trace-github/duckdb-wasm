#pragma once

#ifdef DUCKDB_WASMFS

#include "duckdb/common/file_system.hpp"

namespace duckdb {
namespace web {
namespace io {

class WasmFSFileHandle : public FileHandle {
public:
    WasmFSFileHandle(FileSystem &file_system, string path, FileOpenFlags flags, int fd);
    ~WasmFSFileHandle() override;

    void Close() override;

    int fd;
};

class WasmFSFileSystem : public FileSystem {
public:
    WasmFSFileSystem() = default;

    unique_ptr<FileHandle> OpenFile(const string &path, FileOpenFlags flags,
                                    optional_ptr<FileOpener> opener = nullptr) override;

    void Read(FileHandle &handle, void *buffer, int64_t nr_bytes, idx_t location) override;
    void Write(FileHandle &handle, void *buffer, int64_t nr_bytes, idx_t location) override;
    int64_t Read(FileHandle &handle, void *buffer, int64_t nr_bytes) override;
    int64_t Write(FileHandle &handle, void *buffer, int64_t nr_bytes) override;

    int64_t GetFileSize(FileHandle &handle) override;
    timestamp_t GetLastModifiedTime(FileHandle &handle) override;
    bool FileExists(const string &filename, optional_ptr<FileOpener> opener = nullptr) override;
    void RemoveFile(const string &filename, optional_ptr<FileOpener> opener = nullptr) override;
    void MoveFile(const string &source, const string &target,
                  optional_ptr<FileOpener> opener = nullptr) override;
    void Truncate(FileHandle &handle, int64_t new_size) override;
    void FileSync(FileHandle &handle) override;
    void Seek(FileHandle &handle, idx_t location) override;
    void Reset(FileHandle &handle) override;
    idx_t SeekPosition(FileHandle &handle) override;
    bool OnDiskFile(FileHandle &handle) override { return true; }
    bool CanSeek() override { return true; }

    bool CanHandleFile(const string &fpath) override;
    string GetName() const override { return "WasmFSFileSystem"; }

    vector<OpenFileInfo> Glob(const string &path, FileOpener *opener = nullptr) override;

private:
    static string TranslatePath(const string &path);
};

}  // namespace io
}  // namespace web
}  // namespace duckdb

#endif  // DUCKDB_WASMFS
