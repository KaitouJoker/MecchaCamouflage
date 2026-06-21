#pragma once

#include <cstdint>
#include <string>

namespace MecchaCamouflage::Diagnostics
{
    struct LastStatusSnapshot
    {
        const char* phase{"unknown"};
        bool target_resolve_ok{false};
        std::uint64_t play_id{0};
        int success{0};
        int failures{0};
        bool visible_backend{false};
        int body_hits{0};
        int uv_hits{0};
        std::string paint_backend{};
        std::string last_failure{};
        std::string world{};
        std::string pawn{};
        std::string component{};
    };

    void write_last_status_file(const LastStatusSnapshot& snapshot);
}
