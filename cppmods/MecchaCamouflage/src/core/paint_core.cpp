#include "MecchaCamouflage/core/paint_core.hpp"

#include <algorithm>
#include <cmath>
#include <thread>

namespace MecchaCamouflage::Core
{
    namespace
    {
        struct ProjectionTexel
        {
            double r{0.0};
            double g{0.0};
            double b{0.0};
            double roughness{0.0};
            double metallic{0.0};
            double weight{0.0};
            int priority{0};
            bool floor_like{false};
        };

        auto clamp(double value, double min_value, double max_value) -> double
        {
            return std::max(min_value, std::min(max_value, value));
        }

        auto worker_count_for_items(std::size_t item_count) -> unsigned
        {
            const auto hardware = std::max(1U, std::thread::hardware_concurrency());
            const auto useful = item_count < 65536
                                    ? 1U
                                    : std::min<unsigned>(hardware, static_cast<unsigned>((item_count + 65535) / 65536));
            return std::max(1U, useful);
        }

        template <typename Fn>
        auto parallel_ranges(std::size_t item_count, Fn&& fn) -> void
        {
            const auto workers = worker_count_for_items(item_count);
            if (workers <= 1 || item_count == 0)
            {
                fn(0, item_count, 0);
                return;
            }

            std::vector<std::thread> threads{};
            threads.reserve(workers);
            for (unsigned worker = 0; worker < workers; ++worker)
            {
                const auto begin = (item_count * static_cast<std::size_t>(worker)) / static_cast<std::size_t>(workers);
                const auto end = (item_count * static_cast<std::size_t>(worker + 1)) / static_cast<std::size_t>(workers);
                threads.emplace_back([begin, end, worker, &fn]() {
                    fn(begin, end, worker);
                });
            }
            for (auto& thread : threads)
            {
                if (thread.joinable())
                {
                    thread.join();
                }
            }
        }

        auto projection_texel_painted(const ProjectionTexel& texel) -> bool
        {
            return texel.weight > 0.000001;
        }

        auto splat_projection_texel(std::vector<ProjectionTexel>& texels,
                                    int width,
                                    int height,
                                    double u,
                                    double v,
                                    const Color& color,
                                    double weight,
                                    int priority,
                                    bool floor_like,
                                    int radius) -> void
        {
            if (width <= 0 || height <= 0 || texels.empty())
            {
                return;
            }

            const auto center_x = static_cast<int>(std::round(clamp(u, 0.0, 1.0) * static_cast<double>(width - 1)));
            const auto center_y = static_cast<int>(std::round(clamp(v, 0.0, 1.0) * static_cast<double>(height - 1)));
            for (int dy = -radius; dy <= radius; ++dy)
            {
                for (int dx = -radius; dx <= radius; ++dx)
                {
                    const auto x = center_x + dx;
                    const auto y = center_y + dy;
                    if (x < 0 || y < 0 || x >= width || y >= height)
                    {
                        continue;
                    }
                    const auto dist_sq = static_cast<double>(dx * dx + dy * dy);
                    const auto radius_sq = static_cast<double>(std::max(1, radius) * std::max(1, radius));
                    const auto local_weight = radius <= 0 ? weight : weight * clamp(1.0 - dist_sq / (radius_sq + 1.0), 0.15, 1.0);
                    const auto index = static_cast<std::size_t>(y * width + x);
                    auto& texel = texels[index];
                    if (priority < texel.priority)
                    {
                        continue;
                    }
                    if (priority > texel.priority)
                    {
                        texel = ProjectionTexel{};
                        texel.priority = priority;
                    }
                    texel.r += color.r * local_weight;
                    texel.g += color.g * local_weight;
                    texel.b += color.b * local_weight;
                    texel.roughness += color.roughness * local_weight;
                    texel.metallic += color.metallic * local_weight;
                    texel.weight += local_weight;
                    texel.floor_like = texel.floor_like || floor_like;
                }
            }
        }
    }

    auto clamp_unit(double value) -> double
    {
        return clamp(value, 0.0, 1.0);
    }

    auto byte_from_unit(double value) -> std::uint8_t
    {
        const auto clamped = clamp_unit(value);
        return static_cast<std::uint8_t>(std::round(clamped * 255.0));
    }

    auto chroma_distance_rgb(const Color& a, const Color& b) -> double
    {
        const auto ar = a.r - (a.r + a.g + a.b) / 3.0;
        const auto ag = a.g - (a.r + a.g + a.b) / 3.0;
        const auto ab = a.b - (a.r + a.g + a.b) / 3.0;
        const auto br = b.r - (b.r + b.g + b.b) / 3.0;
        const auto bg = b.g - (b.r + b.g + b.b) / 3.0;
        const auto bb = b.b - (b.r + b.g + b.b) / 3.0;
        return std::sqrt((ar - br) * (ar - br) + (ag - bg) * (ag - bg) + (ab - bb) * (ab - bb));
    }

    auto hash_bytes(const std::vector<std::uint8_t>& bytes) -> std::uint64_t
    {
        std::uint64_t hash = 1469598103934665603ULL;
        for (const auto byte : bytes)
        {
            hash ^= static_cast<std::uint64_t>(byte);
            hash *= 1099511628211ULL;
        }
        return hash;
    }

    auto changed_byte_count(const std::vector<std::uint8_t>& before,
                            const std::vector<std::uint8_t>& after) -> int
    {
        const auto count = std::min(before.size(), after.size());
        int changed = 0;
        for (std::size_t i = 0; i < count; ++i)
        {
            if (before[i] != after[i])
            {
                ++changed;
            }
        }
        changed += static_cast<int>(std::max(before.size(), after.size()) - count);
        return changed;
    }

    auto validate_capture_quality(const CaptureQualityInput& input) -> CaptureQualityDecision
    {
        if (!input.image_ok)
        {
            return {false, "capture_image_unavailable"};
        }
        if (!input.bulk_calibration_ok || input.bulk_best_median > MaxBulkMedianRgbError)
        {
            return {false, "bulk_calibration_failed_no_paint"};
        }
        if (input.trace_hits < input.min_hits || input.background_pixels < input.min_hits)
        {
            return {false, "insufficient_validated_samples_no_paint"};
        }
        if (input.uniform || input.clear_suspect)
        {
            return {false, "capture_color_quality_failed_no_paint"};
        }
        return {true, "ok"};
    }

    auto assemble_direct_texture(const ChannelBuffer& albedo_before,
                                 const ChannelBuffer& metallic_before,
                                 const ChannelBuffer& roughness_before,
                                 const std::vector<PaintSeed>& seeds) -> TextureAssemblyResult
    {
        TextureAssemblyResult result{};
        result.albedo = albedo_before;
        result.metallic = metallic_before;
        result.roughness = roughness_before;

        const auto texture_pixels = static_cast<std::size_t>(std::max(0, albedo_before.width)) *
                                    static_cast<std::size_t>(std::max(0, albedo_before.height));
        std::vector<ProjectionTexel> texels(texture_pixels);
        for (const auto& seed : seeds)
        {
            const auto priority = seed.floor_like ? 12 : 11;
            const auto weight = seed.floor_like ? 88.0 : 72.0;
            splat_projection_texel(texels,
                                   albedo_before.width,
                                   albedo_before.height,
                                   seed.u,
                                   seed.v,
                                   seed.color,
                                   weight,
                                   priority,
                                   seed.floor_like,
                                   2);
        }

        std::vector<std::uint8_t> direct_mask(texture_pixels, 0);
        for (std::size_t index = 0; index < texels.size(); ++index)
        {
            if (projection_texel_painted(texels[index]))
            {
                direct_mask[index] = 1;
                ++result.stats.direct_texels;
            }
        }

        constexpr int front_gap_fill_radius = 6;
        auto extended_texels = texels;
        parallel_ranges(texture_pixels, [&](std::size_t begin, std::size_t end, unsigned) {
            const auto width = std::max(1, albedo_before.width);
            const auto height = std::max(1, albedo_before.height);
            for (std::size_t index = begin; index < end; ++index)
            {
                if (index >= texels.size() || direct_mask[index] != 0)
                {
                    continue;
                }
                const auto y = static_cast<int>(index / static_cast<std::size_t>(width));
                const auto x = static_cast<int>(index - static_cast<std::size_t>(y * width));
                int best_distance_sq = front_gap_fill_radius * front_gap_fill_radius + 1;
                int best_priority = -1;
                std::size_t best_index = static_cast<std::size_t>(-1);
                for (int dy = -front_gap_fill_radius; dy <= front_gap_fill_radius; ++dy)
                {
                    const auto sy = y + dy;
                    if (sy < 0 || sy >= height)
                    {
                        continue;
                    }
                    for (int dx = -front_gap_fill_radius; dx <= front_gap_fill_radius; ++dx)
                    {
                        const auto sx = x + dx;
                        if (sx < 0 || sx >= width)
                        {
                            continue;
                        }
                        const auto distance_sq = dx * dx + dy * dy;
                        if (distance_sq > front_gap_fill_radius * front_gap_fill_radius)
                        {
                            continue;
                        }
                        const auto source_index = static_cast<std::size_t>(sy * width + sx);
                        if (source_index >= texels.size() || direct_mask[source_index] == 0 ||
                            !projection_texel_painted(texels[source_index]))
                        {
                            continue;
                        }
                        const auto priority = texels[source_index].priority;
                        if (distance_sq < best_distance_sq ||
                            (distance_sq == best_distance_sq && priority > best_priority) ||
                            (distance_sq == best_distance_sq && priority == best_priority && source_index < best_index))
                        {
                            best_distance_sq = distance_sq;
                            best_priority = priority;
                            best_index = source_index;
                        }
                    }
                }
                if (best_index == static_cast<std::size_t>(-1))
                {
                    continue;
                }

                const auto& source = texels[best_index];
                const auto inv = 1.0 / source.weight;
                ProjectionTexel copy{};
                copy.r = source.r * inv;
                copy.g = source.g * inv;
                copy.b = source.b * inv;
                copy.roughness = source.roughness * inv;
                copy.metallic = source.metallic * inv;
                copy.weight = 1.0;
                copy.priority = source.priority;
                copy.floor_like = source.floor_like;
                extended_texels[index] = copy;
            }
        });
        texels.swap(extended_texels);

        result.stats.worker_threads = worker_count_for_items(texture_pixels);
        std::vector<TextureWriteStats> worker_stats(result.stats.worker_threads);
        const auto write_scalar = [](std::vector<std::uint8_t>& bytes, int x, int y, int width, double value) {
            const auto offset = static_cast<std::size_t>(y * width + x) * 4;
            if (offset < bytes.size())
            {
                bytes[offset] = byte_from_unit(value);
            }
        };

        parallel_ranges(texture_pixels, [&](std::size_t begin, std::size_t end, unsigned worker) {
            auto& local = worker_stats[static_cast<std::size_t>(worker)];
            for (std::size_t index = begin; index < end; ++index)
            {
                if (index >= texels.size())
                {
                    continue;
                }
                const auto y = static_cast<int>(index / static_cast<std::size_t>(std::max(1, albedo_before.width)));
                const auto x = static_cast<int>(index - static_cast<std::size_t>(y * albedo_before.width));
                const auto offset = index * 4;
                const auto& source = texels[index];
                if (!projection_texel_painted(source) || offset + 2 >= result.albedo.bytes.size())
                {
                    ++local.preserved_original;
                    continue;
                }

                const auto inv = 1.0 / source.weight;
                result.albedo.bytes[offset + 0] = byte_from_unit(clamp(source.r * inv, 0.02, 0.98));
                result.albedo.bytes[offset + 1] = byte_from_unit(clamp(source.g * inv, 0.02, 0.98));
                result.albedo.bytes[offset + 2] = byte_from_unit(clamp(source.b * inv, 0.02, 0.98));
                if (x < result.metallic.width && y < result.metallic.height)
                {
                    write_scalar(result.metallic.bytes, x, y, result.metallic.width, clamp(source.metallic * inv, 0.0, 1.0));
                }
                if (x < result.roughness.width && y < result.roughness.height)
                {
                    write_scalar(result.roughness.bytes, x, y, result.roughness.width, clamp(source.roughness * inv, 0.0, 1.0));
                }

                ++local.uv_coverage;
                if (direct_mask[index] != 0)
                {
                    ++local.filled_by_direct;
                }
                else
                {
                    ++local.filled_by_extension;
                }
                if (source.floor_like)
                {
                    ++local.filled_by_floor;
                }
            }
        });

        for (const auto& local : worker_stats)
        {
            result.stats.uv_coverage += local.uv_coverage;
            result.stats.filled_by_direct += local.filled_by_direct;
            result.stats.filled_by_extension += local.filled_by_extension;
            result.stats.filled_by_floor += local.filled_by_floor;
            result.stats.preserved_original += local.preserved_original;
        }

        return result;
    }
}
