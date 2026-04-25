#pragma once

#include <mutex>

#include "System/Threading/SpringThreading.h"
#include "System/Threading/WrappedSync.h"
#include "System/ScopedResource.h"

// Headless server: GL context management removed, just use a plain mutex
class CLoadLockMtx {
public:
	using native_handle_type = uint32_t;

	void lock() { mtx.lock(); }
	void unlock() { mtx.unlock(); }
	bool try_lock() { return mtx.try_lock(); }
	native_handle_type native_handle() { return native_handle_type{}; }
private:
	std::recursive_mutex mtx = {};
};

class CLoadLockImpl : public spring::WrappedSync<CLoadLockMtx> {
public:
	CLoadLockImpl() : spring::WrappedSync<CLoadLockMtx>() {
		needThreadSafety = false;
	}
	auto& GetMutex() {
		return *sync[needThreadSafety];
	}
};

class CLoadLock {
public:
	static auto& GetMutex() {
		return loadLockImpl.GetMutex();
	}
	static auto GetUniqueLock() {
		return loadLockImpl.GetUniqueLock();
	}
	static void SetThreadSafety(bool b) { loadLockImpl.SetThreadSafety(b); }
	static bool GetThreadSafety() { return loadLockImpl.GetThreadSafety(); }
private:
	inline static CLoadLockImpl loadLockImpl;
};
