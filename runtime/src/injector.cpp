#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <tlhelp32.h>

#include <iostream>
#include <sstream>
#include <string>

namespace
{
    auto utf8(const std::wstring& value) -> std::string
    {
        if (value.empty())
        {
            return {};
        }
        const int size = WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
        if (size <= 0)
        {
            return {};
        }
        std::string result(static_cast<std::size_t>(size), '\0');
        WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), &result[0], size, nullptr, nullptr);
        return result;
    }

    auto json_escape(const std::string& value) -> std::string
    {
        std::string escaped;
        escaped.reserve(value.size() + 8);
        for (const char ch : value)
        {
            switch (ch)
            {
            case '\\': escaped += "\\\\"; break;
            case '"': escaped += "\\\""; break;
            case '\n': escaped += "\\n"; break;
            case '\r': escaped += "\\r"; break;
            case '\t': escaped += "\\t"; break;
            default:
                if (static_cast<unsigned char>(ch) < 0x20)
                {
                    escaped += "?";
                }
                else
                {
                    escaped += ch;
                }
                break;
            }
        }
        return escaped;
    }

    auto write_event(const char* phase, bool success, DWORD win32_error = 0, const std::string& detail = {}, DWORD pid = 0, DWORD remote_exit = 0) -> void
    {
        std::ostringstream out;
        out << "{\"phase\":\"" << phase << "\",\"success\":" << (success ? "true" : "false");
        if (pid != 0)
        {
            out << ",\"pid\":" << pid;
        }
        if (win32_error != 0)
        {
            out << ",\"win32\":" << win32_error;
        }
        if (remote_exit != 0)
        {
            out << ",\"remote_exit\":" << remote_exit;
        }
        if (!detail.empty())
        {
            out << ",\"detail\":\"" << json_escape(detail) << "\"";
        }
        out << "}\n";
        std::cout << out.str();
    }

    auto find_process_id(const std::wstring& process_name) -> DWORD
    {
        write_event("process_lookup", true, 0, utf8(process_name));
        PROCESSENTRY32W entry{};
        entry.dwSize = sizeof(entry);
        HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snapshot == INVALID_HANDLE_VALUE)
        {
            write_event("process_lookup", false, GetLastError(), "CreateToolhelp32Snapshot failed");
            return 0;
        }

        DWORD pid = 0;
        if (Process32FirstW(snapshot, &entry))
        {
            do
            {
                if (_wcsicmp(entry.szExeFile, process_name.c_str()) == 0)
                {
                    pid = entry.th32ProcessID;
                    break;
                }
            } while (Process32NextW(snapshot, &entry));
        }
        CloseHandle(snapshot);
        write_event("process_lookup_result", pid != 0, 0, utf8(process_name), pid);
        return pid;
    }

    auto inject_dll(DWORD pid, const std::wstring& dll_path) -> int
    {
        write_event("open_process", true, 0, {}, pid);
        HANDLE process = OpenProcess(PROCESS_CREATE_THREAD | PROCESS_QUERY_INFORMATION |
                                         PROCESS_VM_OPERATION | PROCESS_VM_WRITE | PROCESS_VM_READ,
                                     FALSE,
                                     pid);
        if (!process)
        {
            const auto error = GetLastError();
            write_event("open_process", false, error, "OpenProcess failed", pid);
            std::wcerr << L"OpenProcess failed win32=" << error << L"\n";
            return 2;
        }

        const SIZE_T bytes = (dll_path.size() + 1) * sizeof(wchar_t);
        write_event("virtual_alloc", true, 0, {}, pid);
        LPVOID remote = VirtualAllocEx(process, nullptr, bytes, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE);
        if (!remote)
        {
            const auto error = GetLastError();
            write_event("virtual_alloc", false, error, "VirtualAllocEx failed", pid);
            std::wcerr << L"VirtualAllocEx failed win32=" << error << L"\n";
            CloseHandle(process);
            return 3;
        }

        write_event("write_process_memory", true, 0, "bytes=" + std::to_string(bytes), pid);
        if (!WriteProcessMemory(process, remote, dll_path.c_str(), bytes, nullptr))
        {
            const auto error = GetLastError();
            write_event("write_process_memory", false, error, "WriteProcessMemory failed", pid);
            std::wcerr << L"WriteProcessMemory failed win32=" << error << L"\n";
            VirtualFreeEx(process, remote, 0, MEM_RELEASE);
            CloseHandle(process);
            return 4;
        }

        HMODULE kernel32 = GetModuleHandleW(L"kernel32.dll");
        auto load_library = reinterpret_cast<LPTHREAD_START_ROUTINE>(GetProcAddress(kernel32, "LoadLibraryW"));
        write_event("create_remote_thread", true, 0, utf8(dll_path), pid);
        HANDLE thread = CreateRemoteThread(process, nullptr, 0, load_library, remote, 0, nullptr);
        if (!thread)
        {
            const auto error = GetLastError();
            write_event("create_remote_thread", false, error, "CreateRemoteThread failed", pid);
            std::wcerr << L"CreateRemoteThread failed win32=" << error << L"\n";
            VirtualFreeEx(process, remote, 0, MEM_RELEASE);
            CloseHandle(process);
            return 5;
        }

        const DWORD wait_result = WaitForSingleObject(thread, 10000);
        if (wait_result != WAIT_OBJECT_0)
        {
            write_event("wait_remote_thread", false, wait_result, "remote LoadLibraryW thread did not finish", pid);
        }
        DWORD remote_exit = 0;
        GetExitCodeThread(thread, &remote_exit);
        write_event("remote_load_result", remote_exit != 0, 0, remote_exit == 0 ? "LoadLibraryW returned null without remote GetLastError" : "LoadLibraryW returned non-null", pid, remote_exit);
        CloseHandle(thread);
        VirtualFreeEx(process, remote, 0, MEM_RELEASE);
        CloseHandle(process);

        if (remote_exit == 0)
        {
            std::wcerr << L"LoadLibraryW failed in target process\n";
            return 6;
        }
        return 0;
    }
}

int wmain(int argc, wchar_t** argv)
{
    if (argc == 2 && std::wstring(argv[1]) == L"--self-test")
    {
        write_event("self_test", true, 0, "runtime-injector");
        return 0;
    }
    if (argc < 3)
    {
        write_event("arguments", false, 0, "usage: runtime-injector.exe <process.exe> <bridge.dll>");
        std::wcerr << L"usage: runtime-injector.exe <process.exe> <bridge.dll>\n";
        return 64;
    }
    const std::wstring process_name = argv[1];
    const std::wstring dll_path = argv[2];
    const DWORD pid = find_process_id(process_name);
    if (!pid)
    {
        write_event("process_lookup_result", false, 0, "process not found: " + utf8(process_name));
        std::wcerr << L"process not found: " << process_name << L"\n";
        return 1;
    }
    const int result = inject_dll(pid, dll_path);
    if (result == 0)
    {
        write_event("complete", true, 0, utf8(dll_path), pid);
        std::wcout << L"injected pid=" << pid << L" dll=" << dll_path << L"\n";
    }
    return result;
}
