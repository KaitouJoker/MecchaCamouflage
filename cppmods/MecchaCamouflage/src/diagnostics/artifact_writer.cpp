#include "MecchaCamouflage/diagnostics/artifact_writer.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <sstream>

namespace MecchaCamouflage::Diagnostics
{
    namespace
    {
        auto byte_from_unit(double value) -> unsigned char
        {
            return static_cast<unsigned char>(Core::byte_from_unit(value));
        }

        auto write_json_string(std::ostream& out, const std::string& value) -> void
        {
            out << "\"";
            for (const auto ch : value)
            {
                switch (ch)
                {
                case '\\':
                    out << "\\\\";
                    break;
                case '"':
                    out << "\\\"";
                    break;
                case '\n':
                    out << "\\n";
                    break;
                case '\r':
                    out << "\\r";
                    break;
                case '\t':
                    out << "\\t";
                    break;
                default:
                    out << ch;
                    break;
                }
            }
            out << "\"";
        }

        auto make_run_dir(std::uint64_t run_id) -> std::filesystem::path
        {
            const auto now = std::chrono::system_clock::now().time_since_epoch();
            const auto millis = std::chrono::duration_cast<std::chrono::milliseconds>(now).count();
            std::ostringstream name{};
            name << "run_" << run_id << "_" << millis;
            auto dir = std::filesystem::path{"MecchaCamouflageDebug"} / name.str();
            std::filesystem::create_directories(dir);
            return dir;
        }

        auto write_ppm(const std::filesystem::path& path, const DiagnosticImage& image) -> void
        {
            if (image.width <= 0 || image.height <= 0 ||
                image.pixels.size() < static_cast<std::size_t>(image.width * image.height))
            {
                return;
            }
            std::ofstream out{path, std::ios::binary};
            if (!out)
            {
                return;
            }
            out << "P6\n" << image.width << " " << image.height << "\n255\n";
            for (int y = 0; y < image.height; ++y)
            {
                for (int x = 0; x < image.width; ++x)
                {
                    const auto& color = image.pixels[static_cast<std::size_t>(y * image.width + x)];
                    const unsigned char rgb[3]{
                        byte_from_unit(color.r),
                        byte_from_unit(color.g),
                        byte_from_unit(color.b)};
                    out.write(reinterpret_cast<const char*>(rgb), 3);
                }
            }
        }

        auto write_albedo_ppm(const std::filesystem::path& path, const DiagnosticAlbedo& image) -> void
        {
            if (image.width <= 0 || image.height <= 0 ||
                image.rgba.size() < static_cast<std::size_t>(image.width * image.height * 4))
            {
                return;
            }
            std::ofstream out{path, std::ios::binary};
            if (!out)
            {
                return;
            }
            out << "P6\n" << image.width << " " << image.height << "\n255\n";
            for (int y = 0; y < image.height; ++y)
            {
                for (int x = 0; x < image.width; ++x)
                {
                    const auto offset = static_cast<std::size_t>(y * image.width + x) * 4;
                    const unsigned char rgb[3]{
                        image.rgba[offset + 0],
                        image.rgba[offset + 1],
                        image.rgba[offset + 2]};
                    out.write(reinterpret_cast<const char*>(rgb), 3);
                }
            }
        }

        auto write_body_mask(const std::filesystem::path& path,
                             int width,
                             int height,
                             const std::vector<DiagnosticSample>& samples) -> void
        {
            if (width <= 0 || height <= 0)
            {
                return;
            }
            std::vector<unsigned char> mask(static_cast<std::size_t>(width * height), 0);
            for (const auto& sample : samples)
            {
                const auto x = static_cast<int>(std::round(sample.screen_x));
                const auto y = static_cast<int>(std::round(sample.screen_y));
                if (x < 0 || y < 0 || x >= width || y >= height)
                {
                    continue;
                }
                mask[static_cast<std::size_t>(y * width + x)] = 255;
            }

            std::ofstream out{path, std::ios::binary};
            if (!out)
            {
                return;
            }
            out << "P5\n" << width << " " << height << "\n255\n";
            out.write(reinterpret_cast<const char*>(mask.data()), static_cast<std::streamsize>(mask.size()));
        }

        auto write_samples_csv(const std::filesystem::path& path,
                               const std::vector<DiagnosticSample>& samples,
                               bool rejected_only) -> void
        {
            std::ofstream out{path};
            if (!out)
            {
                return;
            }
            out << "screen_x,screen_y,u,v,world_x,world_y,world_z,has_capture,capture_r,capture_g,capture_b,has_trace,trace_r,trace_g,trace_b,chroma_distance,rejected\n";
            for (const auto& sample : samples)
            {
                if (rejected_only && !sample.rejected)
                {
                    continue;
                }
                out << sample.screen_x << "," << sample.screen_y << ","
                    << sample.u << "," << sample.v << ","
                    << sample.world_x << "," << sample.world_y << "," << sample.world_z << ","
                    << (sample.has_capture ? 1 : 0) << ","
                    << sample.capture.r << "," << sample.capture.g << "," << sample.capture.b << ","
                    << (sample.has_trace ? 1 : 0) << ","
                    << sample.trace.r << "," << sample.trace.g << "," << sample.trace.b << ","
                    << sample.chroma_distance << ","
                    << (sample.rejected ? 1 : 0) << "\n";
            }
        }
    }

    auto write_run_artifacts(const RunArtifactData& data) -> std::string
    {
        const auto dir = make_run_dir(data.run_id);

        {
            std::ofstream out{dir / "run.json"};
            if (out)
            {
                out << "{\n";
                out << "  \"run_id\": " << data.run_id << ",\n";
                out << "  \"stage\": \"" << data.stage << "\",\n";
                out << "  \"failure\": \"" << data.failure << "\",\n";
                out << "  \"readback_backend\": \"" << data.readback_backend << "\",\n";
                out << "  \"validation_ok\": " << (data.validation_ok ? "true" : "false") << ",\n";
                out << "  \"image_ok\": " << (data.image_ok ? "true" : "false") << ",\n";
                out << "  \"bulk_calibration_ok\": " << (data.bulk_calibration_ok ? "true" : "false") << ",\n";
                out << "  \"bulk_pairs\": " << data.bulk_pairs << ",\n";
                out << "  \"bulk_best_median\": " << data.bulk_best_median << ",\n";
                out << "  \"bulk_runner_up_median\": " << data.bulk_runner_up_median << ",\n";
                out << "  \"capture_trace_chroma_avg\": " << data.capture_trace_chroma_avg << ",\n";
                out << "  \"capture_trace_chroma_p95\": " << data.capture_trace_chroma_p95 << ",\n";
                out << "  \"bulk_calibration_candidates\": [";
                for (std::size_t i = 0; i < data.bulk_calibration_candidates.size(); ++i)
                {
                    if (i > 0)
                    {
                        out << ", ";
                    }
                    write_json_string(out, data.bulk_calibration_candidates[i]);
                }
                out << "],\n";
                out << "  \"sample_count\": " << data.samples.size() << "\n";
                out << "}\n";
            }
        }

        {
            std::ofstream out{dir / "capture_calibration.json"};
            if (out)
            {
                out << "{\n";
                out << "  \"image_ok\": " << (data.image_ok ? "true" : "false") << ",\n";
                out << "  \"bulk_calibration_ok\": " << (data.bulk_calibration_ok ? "true" : "false") << ",\n";
                out << "  \"bulk_pairs\": " << data.bulk_pairs << ",\n";
                out << "  \"bulk_best_median\": " << data.bulk_best_median << ",\n";
                out << "  \"bulk_runner_up_median\": " << data.bulk_runner_up_median << ",\n";
                out << "  \"candidates\": [";
                for (std::size_t i = 0; i < data.bulk_calibration_candidates.size(); ++i)
                {
                    if (i > 0)
                    {
                        out << ", ";
                    }
                    write_json_string(out, data.bulk_calibration_candidates[i]);
                }
                out << "]\n";
                out << "}\n";
            }
        }

        write_samples_csv(dir / "samples.csv", data.samples, false);
        write_samples_csv(dir / "rejected_samples.csv", data.samples, true);
        write_body_mask(dir / "body_mask.pgm", data.viewport_width, data.viewport_height, data.samples);
        if (data.capture_preview)
        {
            write_ppm(dir / "capture_preview.ppm", *data.capture_preview);
        }
        if (data.target_albedo)
        {
            write_albedo_ppm(dir / "target_albedo.ppm", *data.target_albedo);
        }

        return dir.string();
    }
}
