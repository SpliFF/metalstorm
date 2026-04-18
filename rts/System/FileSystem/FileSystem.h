/**
 * Stub — FileSystem static utilities.
 * Wraps std::filesystem for path operations that sim code uses.
 */
#pragma once

#include <string>
#include <filesystem>

namespace FileSystem {
	inline std::string GetExtension(const std::string& path) {
		auto ext = std::filesystem::path(path).extension().string();
		if (!ext.empty() && ext[0] == '.') ext = ext.substr(1);
		return ext;
	}
	inline std::string GetFilename(const std::string& path) {
		return std::filesystem::path(path).filename().string();
	}
	inline std::string GetBasename(const std::string& path) {
		return std::filesystem::path(path).stem().string();
	}
	inline std::string GetDirectory(const std::string& path) {
		auto dir = std::filesystem::path(path).parent_path().string();
		if (!dir.empty() && dir.back() != '/') dir += '/';
		return dir;
	}
	inline std::string GetNormalizedPath(const std::string& path) {
		return std::filesystem::path(path).lexically_normal().string();
	}

	inline std::string GetCacheDir() {
		return "cache/";
	}

	inline bool FileExists(const std::string& path) {
		return std::filesystem::exists(path);
	}
	inline bool DirExists(const std::string& path) {
		return std::filesystem::is_directory(path);
	}
	inline size_t GetFileSize(const std::string& path) {
		std::error_code ec;
		auto s = std::filesystem::file_size(path, ec);
		return ec ? 0 : s;
	}
	inline std::string GetFileModificationDate(const std::string&) {
		return "19700101000000"; // stub — returns epoch
	}
	inline bool Remove(const std::string& path) {
		std::error_code ec;
		return std::filesystem::remove(path, ec);
	}
	inline bool CreateDirectory(const std::string& path) {
		std::error_code ec;
		std::filesystem::create_directories(path, ec);
		return !ec;
	}
}
