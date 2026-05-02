# Chain-sidecar — Node 20+ TypeScript build hooked into the agent_bundle target.
#
# The sidecar lives outside the C++ build (it's just a Node process), but we still want
# `cmake --build build --target agent_bundle` to drop a ready-to-run `dist/main.js`
# alongside the game binary. This CMakeLists.txt:
#
#   1. Locates `node` and `npm` on PATH; if missing, prints a friendly skip notice and
#      registers no targets — keeps Windows / minimal CI builds working.
#   2. Adds a `chain-sidecar` custom target that runs `npm ci && npm run build` whenever
#      `package.json`, `package-lock.json`, `tsconfig.json`, or anything under `src/` changes.
#   3. Wires `chain-sidecar` into the parent's `agent_bundle` target if it exists.

find_program(NODE_EXECUTABLE node)
find_program(NPM_EXECUTABLE npm)

if (NOT NODE_EXECUTABLE OR NOT NPM_EXECUTABLE)
    message(STATUS
        "chain-sidecar: node/npm not found — skipping sidecar build target. "
        "Install Node.js 20+ to enable. (Game + rctctl unaffected.)")
    return()
endif()

set(SIDECAR_DIR "${CMAKE_CURRENT_LIST_DIR}")
set(SIDECAR_STAMP "${SIDECAR_DIR}/dist/.cmake-build-stamp")

file(GLOB_RECURSE SIDECAR_SOURCES CONFIGURE_DEPENDS
    "${SIDECAR_DIR}/src/*.ts"
)

# `npm ci` requires the lockfile; we always have one because it's checked in.
add_custom_command(
    OUTPUT "${SIDECAR_STAMP}"
    COMMAND "${NPM_EXECUTABLE}" ci --no-audit --no-fund
    COMMAND "${NPM_EXECUTABLE}" run build
    COMMAND "${CMAKE_COMMAND}" -E touch "${SIDECAR_STAMP}"
    WORKING_DIRECTORY "${SIDECAR_DIR}"
    DEPENDS
        "${SIDECAR_DIR}/package.json"
        "${SIDECAR_DIR}/package-lock.json"
        "${SIDECAR_DIR}/tsconfig.json"
        ${SIDECAR_SOURCES}
    COMMENT "Building chain-sidecar (Node.js + TypeScript)"
    VERBATIM
)

add_custom_target(chain-sidecar ALL
    DEPENDS "${SIDECAR_STAMP}"
)

if (TARGET agent_bundle)
    add_dependencies(agent_bundle chain-sidecar)
endif()
