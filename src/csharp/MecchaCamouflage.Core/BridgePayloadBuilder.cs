using System.Globalization;
using System.Text.Json;

namespace MecchaCamouflage.Core;

public sealed record ImagePaintOptions(int Width, int Height, string RgbaHex, string AlphaMode, RgbColor BackgroundColor, string Placement, string WrapMode, string BodyType, string FileName);

public sealed record PaintRequestOptions(
    bool PreviewOnly = false,
    bool UnPreviewOnly = false,
    bool ResearchArtifacts = false,
    int DiagnosticStrokeLimit = 0,
    ImagePaintOptions? Image = null);

public static class BridgePayloadBuilder
{
    public static string BuildPaintPayload(AppSettings settings, int processId, string processName, PaintRequestOptions options)
    {
        var paint = SettingsStore.Clamp(settings).Paint;
        var image = options.Image;
        var payload = new Dictionary<string, object?>
        {
            ["type"] = "paint_full_route",
            ["native_apply_mode"] = "native_recorded_paint",
            ["route"] = "native_recorded_paint",
            ["preview_only"] = options.PreviewOnly,
            ["unpreview_only"] = options.UnPreviewOnly,
            ["research_artifacts"] = options.ResearchArtifacts,
            ["process"] = new Dictionary<string, object?>
            {
                ["pid"] = processId,
                ["name"] = processName
            },
            ["tuning"] = new Dictionary<string, object?>
            {
                ["brush_size_texels"] = paint.BrushSizeTexels,
                ["side_source_max_uv"] = paint.SideSourceMaxUv,
                ["front_back_source_max_uv"] = paint.FrontBackSourceMaxUv,
                ["auto_material"] = paint.AutoMaterial,
                ["metallic"] = paint.Metallic,
                ["roughness"] = paint.Roughness,
                ["emissive"] = paint.Emissive,
                ["front_region_mode"] = SettingsStore.RegionModeText(paint.FrontRegionMode),
                ["side_region_mode"] = SettingsStore.RegionModeText(paint.SideRegionMode),
                ["back_region_mode"] = SettingsStore.RegionModeText(paint.BackRegionMode),
                ["fill_color"] = paint.FillColor.ToHex(),
                ["fill_color_r"] = ToUnit(paint.FillColor.R),
                ["fill_color_g"] = ToUnit(paint.FillColor.G),
                ["fill_color_b"] = ToUnit(paint.FillColor.B),
                ["fill_metallic"] = paint.FillMetallic,
                ["fill_roughness"] = paint.FillRoughness,
                ["fill_emissive"] = paint.FillEmissive,
                ["color_compression_tolerance"] = paint.ColorCompressionTolerance
            },
            ["image_paint_enabled"] = image is not null && !options.PreviewOnly && !options.UnPreviewOnly,
            ["image_paint_width"] = image?.Width ?? 0,
            ["image_paint_height"] = image?.Height ?? 0,
            ["image_paint_rgba_hex"] = image?.RgbaHex ?? "",
            ["image_paint_alpha_mode"] = image?.AlphaMode ?? "skip",
            ["image_paint_background_r"] = ToUnit(image?.BackgroundColor.R ?? 255),
            ["image_paint_background_g"] = ToUnit(image?.BackgroundColor.G ?? 255),
            ["image_paint_background_b"] = ToUnit(image?.BackgroundColor.B ?? 255),
            ["image_paint_placement"] = image?.Placement ?? "fit",
            ["image_paint_wrap_mode"] = image?.WrapMode ?? "base",
            ["image_paint_body_type"] = image?.BodyType ?? "round",
            ["image_paint_file_name"] = image?.FileName ?? ""
        };
        if (options.DiagnosticStrokeLimit > 0)
            payload["diagnostic_stroke_limit"] = Math.Clamp(options.DiagnosticStrokeLimit, 1, 10_000);
        return JsonSerializer.Serialize(payload) + "\n";
    }

    private static double ToUnit(byte value) =>
        double.Parse((value / 255.0).ToString("0.########", CultureInfo.InvariantCulture), CultureInfo.InvariantCulture);
}
