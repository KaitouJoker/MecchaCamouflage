#include "MecchaCamouflage/diagnostics/status_writer.hpp"

#include <array>
#include <fstream>
#include <ios>

namespace MecchaCamouflage::Diagnostics
{
    void write_last_status_file(const LastStatusSnapshot& snapshot)
    {
        const std::array<const char*, 4> paths{
            "MecchaCamouflage_last_status.txt",
            "Chameleon/Binaries/Win64/ue4ss/Mods/MecchaCamouflage/MecchaCamouflage_last_status.txt",
            "ue4ss/Mods/MecchaCamouflage/MecchaCamouflage_last_status.txt",
            "Mods/MecchaCamouflage/MecchaCamouflage_last_status.txt"};

        for (const auto* path : paths)
        {
            std::ofstream file{path, std::ios::trunc};
            if (!file)
            {
                continue;
            }

            file << "mod=MecchaCamouflage\n";
            file << "phase=" << snapshot.phase << "\n";
            file << "hotkey=F10\n";
            file << "input_ok=1\n";
            file << "target_resolve_ok=" << (snapshot.target_resolve_ok ? 1 : 0) << "\n";
            file << "play_id=" << snapshot.play_id << "\n";
            file << "success=" << snapshot.success << "\n";
            file << "failures=" << snapshot.failures << "\n";
            file << "visible_backend=" << (snapshot.visible_backend ? 1 : 0) << "\n";
            file << "body_hits=" << snapshot.body_hits << "\n";
            file << "uv_hits=" << snapshot.uv_hits << "\n";
            file << "paint_backend=" << snapshot.paint_backend << "\n";
            file << "last_failure=" << snapshot.last_failure << "\n";
            file << "world=" << snapshot.world << "\n";
            file << "pawn=" << snapshot.pawn << "\n";
            file << "component=" << snapshot.component << "\n";
        }
    }
}
