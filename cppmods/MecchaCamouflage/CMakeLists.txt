cmake_minimum_required(VERSION 3.22)

set(TARGET MecchaCamouflage)
project(${TARGET} LANGUAGES CXX)

option(MECCHA_CAMOUFLAGE_BUILD_TESTS "Build MecchaCamouflage core tests" ON)
option(MECCHA_CAMOUFLAGE_DIAGNOSTICS "Write runtime diagnostics artifacts in dev builds" OFF)

add_library(MecchaCamouflageCore STATIC
    src/core/paint_core.cpp
)
target_include_directories(MecchaCamouflageCore PUBLIC include)

add_library(${TARGET} SHARED
    src/dllmain.cpp
    src/diagnostics/artifact_writer.cpp
    src/diagnostics/status_writer.cpp
)

target_include_directories(${TARGET} PRIVATE include)
target_link_libraries(${TARGET} PUBLIC UE4SS MecchaCamouflageCore)
set_target_properties(${TARGET} PROPERTIES OUTPUT_NAME "MecchaCamouflage")
target_compile_definitions(${TARGET} PRIVATE
    MECCHA_CAMOUFLAGE_DIAGNOSTICS=$<BOOL:${MECCHA_CAMOUFLAGE_DIAGNOSTICS}>
)

if(MECCHA_CAMOUFLAGE_BUILD_TESTS)
    add_executable(MecchaCamouflageTests
        tests/core_tests.cpp
    )
    target_link_libraries(MecchaCamouflageTests PRIVATE MecchaCamouflageCore)
    add_test(NAME MecchaCamouflageCoreTests COMMAND MecchaCamouflageTests)
endif()

if(MSVC)
    target_compile_options(MecchaCamouflageCore PRIVATE /O2 /Oi /Ot)
    target_compile_options(${TARGET} PRIVATE /O2 /Oi /Ot /GL)
    set_source_files_properties(src/dllmain.cpp PROPERTIES COMPILE_OPTIONS /Ob3)
    target_link_options(${TARGET} PRIVATE /LTCG /OPT:REF /OPT:ICF)
    if(MECCHA_CAMOUFLAGE_BUILD_TESTS)
        target_compile_options(MecchaCamouflageTests PRIVATE /O2 /Oi /Ot)
    endif()
endif()
