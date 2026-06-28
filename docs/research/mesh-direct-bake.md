# Mesh Direct Bake Research

The ideal side/back coverage path is direct mesh/UV reasoning rather than view-only paint expansion. This requires reliable access to mesh geometry, UVs, and eventually current skinned pose.

## Current Status

Offline StaticMesh and SkeletalMesh extraction are now working at the research-tool level.

The patched dumper can generate a `.usmap` that CUE4Parse accepts. The latest full asset probe mounted the game IoStore archives with `GAME_UE5_6`, scanned `5511` packages, found `805` StaticMesh exports and `16` SkeletalMesh exports, and converted all found SkeletalMeshes.

The live paint target has now been matched to a converted offline SkeletalMesh:

- runtime source: `runtime_paint_get_initialized_paint_mesh`
- component: `BP_FirstPersonCharacter_cLeon_Character_C.Mesh`
- component class: `SkeletalMeshComponent`
- runtime asset: `/Game/3Dmodel/cLeon/charactor/paintman/skeltal/paintman.paintman`
- offline package: `Chameleon/Content/3Dmodel/cLeon/charactor/paintman/skeltal/paintman.uasset`
- LOD0: `1660` vertices, `8352` indices, `2784` triangles, `28` bones, 1 UV channel, 1 material slot.
- UV0 range: approximately `U 0.000938..0.999023`, `V 0.041077..0.999023`.

Other strong player/body candidates are:

- `Chameleon/Content/3Dmodel/link/newpenguin/SANTA_ver/santapengun.uasset`: `4728` LOD0 vertices, `23712` indices, `40` bones, 1 UV channel, 2 material slots.
- `Chameleon/Content/3Dmodel/link/newpenguin/SK_LINK_Penguin.uasset`: `3468` LOD0 vertices, `18624` indices, `40` bones, 1 UV channel, 2 material slots.
- `Chameleon/Content/3Dmodel/skeltal/penngin_big/pengun.uasset`: `4042` LOD0 vertices, `17856` indices, `34` bones, 1 UV channel, 4 material slots.

`tools/asset_probe` can now export top SkeletalMesh LOD0 geometry JSON under `.build\research\mesh_exports\`. The JSON includes positions, normals, UVs, indices, bone influences, reference bones, skeleton asset, physics asset, bounds, and material slot names. These files are generated research outputs and should not be committed.

Runtime mesh-first paint now reaches the live `paintman` `SkeletalMeshComponent`, reads `28` valid `FTransform` entries through a guarded component array scan, resolves `K2_GetComponentToWorld`, skins the exported vertices in the bridge, and builds front/side/back samples from the current pose. Bind-pose geometry remains useful for offline planner validation, but production paint must use the current pose and fail clearly if pose data cannot be resolved.

`tools/mesh_planner` now provides the first offline approximation. It reads the exported `paintman` LOD0 JSON plus the latest runtime camera direction, classifies triangles as front/side/back using bind-pose normals, and emits side/back UV target samples.

For migration-only color transfer research, `MECCHA_RESEARCH_ARTIFACTS=1 make run` can still produce a generated front-sample sidecar. Formal runtime behavior should not depend on this flag; large sample dumps belong to explicit research workflows.

Latest observed colorized plan:

- front capture samples: `20029`
- side/back targets: `3105`
- target split: `2383` side, `722` back
- nearest-source UV distance: p50 `0.017271`, p90 `0.155525`, p95 `0.197603`, p99 `0.280566`, max `0.317105`

This confirmed the offline pipeline shape, but it also showed raw nearest-UV color transfer can borrow color from far-away UV locations. Runtime replay currently blocks enabled regions when unsafe transfer candidates exceed the configured guard; UV island/body-region filtering is still the next quality upgrade.

Latest live runtime mesh-first check:

- skinned vertices: `1660`
- planned samples: `3785`
- sample split: `1469` front, `769` side, `1547` back
- replayed strokes with default regions: `2238` front+side, `0` back
- `ServerPaintBatch` calls: `15`
- unsafe enabled candidates: `0`

## Mesh-First Workflow Direction

The formal v1.4.0 paint path should be mesh-first:

1. Research tools regenerate the local `paintman` mesh profile after game updates.
2. Runtime resolves the live target, mesh identity, camera state, and current skinned pose.
3. Planner emits front, side, and back regions from the skinned mesh.
4. Replay uses only regions enabled in settings. Defaults are front and side enabled, back disabled.
5. Unsafe candidates are surfaced and block enabled-region replay; they are not silently skipped.
6. Validated strokes replay only through `ServerPaintBatch`.

This is different from trying to make runtime sampling denser or orbiting the camera. The useful split is: research tools regenerate profile data, while runtime performs pose-aware planning and server replay without falling back to screen hit-test sampling.

## Intended Data Flow

1. Generate `Mappings.usmap` with the patched dumper.
2. Use CUE4Parse to load candidate `USkeletalMesh` / `UStaticMesh` packages.
3. Locate player/body/cosmetic mesh candidates and verify `USkeletalMesh` conversion.
4. Confirm LOD vertices, indices, UVs, material slots, skeleton reference data, and bind-pose data.
5. Prepare the release/runtime sidecar with `scripts\research\prepare-mesh-profile.ps1`.
6. Compare offline mesh identity with runtime target actors/components using `front_mesh_candidates`.
7. Resolve current skinned pose in the bridge.
8. Generate one unified front/side/back plan.
9. Replay only enabled regions through `ServerPaintBatch`.

## What This Does Not Solve Yet

- Occlusion-aware side/back fill.
- UV island/region aware color transfer.
- Async replay pacing that does not hold the game thread during batch delay.
- Old dense hit-test route cleanup after repeated successful live runs.

These are the active v1.4.0 implementation targets. Failures should be visible in Log, Trace, and `latest_error.json`, not hidden behind fallback behavior.
