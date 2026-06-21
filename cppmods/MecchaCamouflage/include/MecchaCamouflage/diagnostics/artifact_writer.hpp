#pragma once

#include "MecchaCamouflage/core/paint_core.hpp"

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace MecchaCamouflage::Diagnostics
{
    struct DiagnosticSample
    {
        double screen_x{0.0};
        double screen_y{0.0};
        double u{0.0};
        double v{0.0};
        double world_x{0.0};
        double world_y{0.0};
        double world_z{0.0};
        bool has_capture{false};
        Core::Color capture{};
        bool has_trace{false};
        Core::Color trace{};
        double chroma_distance{0.0};
        bool rejected{false};
    };

    struct DiagnosticImage
    {
        int width{0};
        int height{0};
        std::vector<Core::Color> pixels{};
    };

    struct DiagnosticAlbedo
    {
        int width{0};
        int height{0};
        std::vector<std::uint8_t> rgba{};
    };

    struct RunArtifactData
    {
        std::uint64_t run_id{0};
        std::string stage{"unknown"};
        std::string failure{"not_run"};
        std::string readback_backend{"unknown"};
        bool validation_ok{false};
        bool image_ok{false};
        bool bulk_calibration_ok{false};
        int bulk_pairs{0};
        double bulk_best_median{0.0};
        double bulk_runner_up_median{0.0};
        double capture_trace_chroma_avg{0.0};
        double capture_trace_chroma_p95{0.0};
        int viewport_width{0};
        int viewport_height{0};
        std::vector<std::string> bulk_calibration_candidates{};
        std::vector<DiagnosticSample> samples{};
        std::optional<DiagnosticImage> capture_preview{};
        std::optional<DiagnosticAlbedo> target_albedo{};
    };

    auto write_run_artifacts(const RunArtifactData& data) -> std::string;
}
