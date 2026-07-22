#include "../include/sdk.hpp"
#include "../include/runtime_contract.hpp"

#include <algorithm>
#include <array>
#include <cstdint>
#include <cstring>
#include <limits>
#include <vector>

int main()
{
    sdk::FTransform valid{};
    valid.Rotation = {0.0, 0.0, 0.705717, 0.708494};
    valid.Translation = {-295.483835, 6223.716973, 8.323874};
    valid.Scale3D = {1.1, 1.1, 1.1};

    sdk::FTransform malformed = valid;
    malformed.Rotation = {0.0, 0.0, -2889820.0, 11160673.0};

    if (!sdk::transform_is_plausible(valid))
    {
        return 1;
    }
    if (sdk::transform_is_plausible(malformed))
    {
        return 2;
    }

    std::array<std::uint8_t, 0x48> fake_property{};
    const std::int32_t array_dim = 1;
    const std::int32_t element_size = 0x20;
    const std::uint64_t property_flags = 0x0018001000000000ULL;
    std::memcpy(fake_property.data() + 0x30, &array_dim, sizeof(array_dim));
    std::memcpy(fake_property.data() + runtime_contract::FPropertyElementSizeOffset,
                &element_size,
                sizeof(element_size));
    std::memcpy(fake_property.data() + 0x38, &property_flags, sizeof(property_flags));
    std::int32_t decoded_element_size = 0;
    std::memcpy(&decoded_element_size,
                fake_property.data() + runtime_contract::FPropertyElementSizeOffset,
                sizeof(decoded_element_size));
    if (decoded_element_size != element_size || runtime_contract::FPropertyElementSizeOffset != 0x34)
    {
        return 3;
    }

    if (!runtime_contract::uobject_flags_usable(0, 0) ||
        runtime_contract::uobject_flags_usable(runtime_contract::RFClassDefaultObject, 0) ||
        runtime_contract::uobject_flags_usable(runtime_contract::RFBeginDestroyed, 0) ||
        runtime_contract::uobject_flags_usable(runtime_contract::RFFinishDestroyed, 0) ||
        runtime_contract::uobject_flags_usable(runtime_contract::RFMirroredGarbage, 0) ||
        runtime_contract::uobject_flags_usable(0, runtime_contract::RFBeginDestroyed) ||
        runtime_contract::uobject_flags_usable(0, runtime_contract::RFFinishDestroyed) ||
        runtime_contract::uobject_flags_usable(0, runtime_contract::RFMirroredGarbage) ||
        !runtime_contract::uobject_flags_usable(0x20000000u, 0))
    {
        return 5;
    }

    if (!runtime_contract::event_watch_generation_active(true, 7, 7) ||
        runtime_contract::event_watch_generation_active(false, 7, 7) ||
        runtime_contract::event_watch_generation_active(true, 8, 7))
    {
        return 9;
    }

    if (runtime_contract::paint_channel_write_cost(4) != 4 ||
        runtime_contract::paint_channel_write_cost(5) != 3 ||
        runtime_contract::paint_channel_write_cost(7) != 1 ||
        runtime_contract::paint_channel_write_cost(0) != 1 ||
        !runtime_contract::local_dispatch_can_append(0, 0, 4, 6, 6) ||
        runtime_contract::local_dispatch_can_append(1, 4, 4, 6, 6) ||
        !runtime_contract::local_dispatch_cpu_budget_reached(1, 4'000) ||
        runtime_contract::local_dispatch_cpu_budget_reached(0, 10'000) ||
        runtime_contract::recurring_scheduler_delay_ms(0) != 1)
    {
        return 10;
    }

    std::array<runtime_contract::SpatialScanlineKey, 4> scanline{{
        {runtime_contract::spatial_scanline_row(100.0, 100.0, 10.0), 10.0, 0},
        {runtime_contract::spatial_scanline_row(100.0, 90.0, 10.0), -20.0, 1},
        {runtime_contract::spatial_scanline_row(100.0, 100.0, 10.0), -10.0, 2},
        {runtime_contract::spatial_scanline_row(100.0, 100.0, 10.0), -10.0, 3},
    }};
    std::stable_sort(scanline.begin(), scanline.end(), runtime_contract::spatial_scanline_less);
    if (scanline[0].original_ordinal != 2 || scanline[1].original_ordinal != 3 ||
        scanline[2].original_ordinal != 0 || scanline[3].original_ordinal != 1)
    {
        return 11;
    }

    const std::vector<runtime_contract::TwoBrushReplayCandidate> routed_candidates{
        {0, runtime_contract::ReplayRegion::Back, runtime_contract::ReplayRegionMode::Fill,
         0, 0.10, 0.10, true, 100.0, 10.0, -5.0, 0},
        {1, runtime_contract::ReplayRegion::Side, runtime_contract::ReplayRegionMode::Paint,
         1, 0.20, 0.20, true, 90.0, 9.0, 0.0, 1},
        {2, runtime_contract::ReplayRegion::Front, runtime_contract::ReplayRegionMode::Skip,
         2, 0.30, 0.30, true, 80.0, 8.0, 5.0, 2},
    };
    const auto routed_plan = runtime_contract::build_two_brush_replay_plan(
        routed_candidates,
        1024,
        true,
        20.0,
        true,
        10.0,
        80.0);
    if (routed_plan.entries.size() != 5 ||
        routed_plan.fill_end != 3 || routed_plan.coarse_end != 4 ||
        routed_plan.fill_count != 3 || routed_plan.coarse_paint_count != 1 ||
        routed_plan.fine_paint_count != 1 ||
        routed_plan.fill_candidates != 3 || routed_plan.fill_deduplicated != 0 ||
        routed_plan.entries[0].pass != runtime_contract::ReplayPass::Fill ||
        routed_plan.entries[0].sample_index != 0 ||
        routed_plan.entries[1].pass != runtime_contract::ReplayPass::Fill ||
        routed_plan.entries[1].sample_index != 1 ||
        routed_plan.entries[2].pass != runtime_contract::ReplayPass::Fill ||
        routed_plan.entries[2].sample_index != 2 ||
        routed_plan.entries[3].pass != runtime_contract::ReplayPass::CoarsePaint ||
        routed_plan.entries[3].sample_index != 1 ||
        routed_plan.entries[4].pass != runtime_contract::ReplayPass::FinePaint ||
        routed_plan.entries[4].sample_index != 1)
    {
        return 12;
    }

    const std::vector<runtime_contract::TwoBrushReplayCandidate> dedupe_candidates{
        {0, runtime_contract::ReplayRegion::Back, runtime_contract::ReplayRegionMode::Fill,
         0, 0.100, 0.100, true, 100.0, 10.0, -5.0, 0},
        {1, runtime_contract::ReplayRegion::Back, runtime_contract::ReplayRegionMode::Fill,
         0, 0.105, 0.105, true, 99.0, 9.0, -4.0, 1},
        {2, runtime_contract::ReplayRegion::Side, runtime_contract::ReplayRegionMode::Paint,
         1, 0.200, 0.200, true, 90.0, 8.0, -3.0, 2},
        {3, runtime_contract::ReplayRegion::Side, runtime_contract::ReplayRegionMode::Paint,
         1, 0.205, 0.205, true, 89.0, 7.0, -2.0, 3},
        {4, runtime_contract::ReplayRegion::Side, runtime_contract::ReplayRegionMode::Paint,
         1, 0.250, 0.250, true, 80.0, 6.0, -1.0, 4},
    };
    const auto dedupe_plan = runtime_contract::build_two_brush_replay_plan(
        dedupe_candidates,
        1024,
        true,
        20.0,
        true,
        10.0,
        80.0);
    if (dedupe_plan.entries.size() != 8 ||
        dedupe_plan.fill_end != 3 || dedupe_plan.coarse_end != 5 ||
        dedupe_plan.fill_count != 3 || dedupe_plan.coarse_paint_count != 2 ||
        dedupe_plan.fine_paint_count != 3 ||
        dedupe_plan.fill_candidates != 5 || dedupe_plan.fill_deduplicated != 2 ||
        dedupe_plan.coarse_paint_candidates != 3 || dedupe_plan.coarse_paint_deduplicated != 1 ||
        dedupe_plan.entries[0].sample_index != 0 ||
        dedupe_plan.entries[1].sample_index != 2 ||
        dedupe_plan.entries[2].sample_index != 4)
    {
        return 13;
    }

    const std::vector<runtime_contract::TwoBrushReplayCandidate> current_view_order_candidates{
        {0, runtime_contract::ReplayRegion::Back, runtime_contract::ReplayRegionMode::Paint,
         0, 0.10, 0.10, true, 90.0, 1000.0, 10.0, 0},
        {1, runtime_contract::ReplayRegion::Back, runtime_contract::ReplayRegionMode::Paint,
         0, 0.20, 0.20, true, 100.0, 0.0, 10.0, 1},
        {2, runtime_contract::ReplayRegion::Back, runtime_contract::ReplayRegionMode::Paint,
         0, 0.30, 0.30, true, 100.0, 0.0, -10.0, 2},
        {3, runtime_contract::ReplayRegion::Back, runtime_contract::ReplayRegionMode::Paint,
         0, 0.40, 0.40, false, 999.0, 80.0, 0.0, 3},
    };
    const auto current_view_order_plan = runtime_contract::build_two_brush_replay_plan(
        current_view_order_candidates,
        1024,
        true,
        20.0,
        true,
        10.0,
        80.0);
    const std::array<std::size_t, 4> expected_current_view_order{{2, 1, 0, 3}};
    for (std::size_t index = 0; index < expected_current_view_order.size(); ++index)
    {
        if (current_view_order_plan.entries[index].sample_index != expected_current_view_order[index] ||
            current_view_order_plan.entries[current_view_order_plan.coarse_end + index].sample_index != expected_current_view_order[index])
        {
            return 14;
        }
    }
    if (!current_view_order_plan.current_view_projection_fallback_used ||
        current_view_order_plan.current_view_projection_fallback_candidates != 1)
    {
        return 14;
    }

    const std::vector<runtime_contract::TwoBrushReplayCandidate> cross_region_view_order_candidates{
        {0, runtime_contract::ReplayRegion::Front, runtime_contract::ReplayRegionMode::Paint,
         0, 0.10, 0.10, true, 300.0, 0.0, 0.0, 0},
        {1, runtime_contract::ReplayRegion::Side, runtime_contract::ReplayRegionMode::Paint,
         0, 0.10, 0.10, true, 200.0, 0.0, 0.0, 1},
        {2, runtime_contract::ReplayRegion::Back, runtime_contract::ReplayRegionMode::Paint,
         0, 0.10, 0.10, true, 100.0, 0.0, 0.0, 2},
    };
    const auto cross_region_view_order_plan = runtime_contract::build_two_brush_replay_plan(
        cross_region_view_order_candidates,
        1024,
        true,
        20.0,
        true,
        10.0,
        80.0);
    const std::array<std::size_t, 3> expected_cross_region_view_order{{0, 1, 2}};
    for (std::size_t index = 0; index < expected_cross_region_view_order.size(); ++index)
    {
        if (cross_region_view_order_plan.entries[index].sample_index != expected_cross_region_view_order[index] ||
            cross_region_view_order_plan.entries[cross_region_view_order_plan.coarse_end + index].sample_index != expected_cross_region_view_order[index])
        {
            return 15;
        }
    }

    const auto brush_1_only_plan = runtime_contract::build_two_brush_replay_plan(
        routed_candidates, 1024, true, 25.0, false, 5.0, 100.0);
    const auto brush_2_only_plan = runtime_contract::build_two_brush_replay_plan(
        routed_candidates, 1024, false, 25.0, true, 5.0, 100.0);
    if (brush_1_only_plan.entries.size() != 4 ||
        brush_1_only_plan.fill_end != 3 || brush_1_only_plan.coarse_end != 4 ||
        brush_1_only_plan.coarse_paint_count != 1 || brush_1_only_plan.fine_paint_count != 0 ||
        brush_1_only_plan.entries[3].pass != runtime_contract::ReplayPass::CoarsePaint ||
        brush_1_only_plan.entries[3].sample_index != 1 ||
        brush_2_only_plan.entries.size() != 4 ||
        brush_2_only_plan.fill_end != 3 || brush_2_only_plan.coarse_end != 3 ||
        brush_2_only_plan.coarse_paint_count != 0 || brush_2_only_plan.fine_paint_count != 1 ||
        brush_2_only_plan.entries[3].pass != runtime_contract::ReplayPass::FinePaint ||
        brush_2_only_plan.entries[3].sample_index != 1)
    {
        return 16;
    }

    const auto fill_window = runtime_contract::replay_pass_window(0, 100, 20, 80);
    const auto coarse_window = runtime_contract::replay_pass_window(20, 100, 20, 80);
    const auto fine_window = runtime_contract::replay_pass_window(80, 100, 20, 80);
    const auto complete_window = runtime_contract::replay_pass_window(100, 100, 20, 80);
    const auto clamped_window = runtime_contract::replay_pass_window(999, 10, 50, 2);
    if (fill_window.pass != runtime_contract::ReplayPass::Fill ||
        fill_window.begin != 0 || fill_window.end != 20 ||
        coarse_window.pass != runtime_contract::ReplayPass::CoarsePaint ||
        coarse_window.begin != 20 || coarse_window.end != 80 ||
        fine_window.pass != runtime_contract::ReplayPass::FinePaint ||
        fine_window.begin != 80 || fine_window.end != 100 ||
        complete_window.pass != runtime_contract::ReplayPass::Complete ||
        complete_window.begin != 100 || complete_window.end != 100 ||
        clamped_window.pass != runtime_contract::ReplayPass::Complete ||
        clamped_window.begin != 10 || clamped_window.end != 10)
    {
        return 22;
    }

    if (runtime_contract::production_material_stroke_count(3) != 3 ||
        runtime_contract::production_material_sample_index(0) != 0 ||
        runtime_contract::production_material_sample_index(1) != 1 ||
        runtime_contract::production_material_sample_index(2) != 2)
    {
        return 23;
    }
    if (runtime_contract::ProductionMaterialPaintChannels !=
        std::array<std::uint8_t, 1>{
            static_cast<std::uint8_t>(sdk::EPaintChannel::AlbedoMetallicRoughnessEmissive)})
    {
        return 26;
    }
    return 0;
}
