# Build-time drift guard for the wire schema (PLAN-protocol-guard task 2).
#
# Recomputes the sha256 of the binary schema from the CURRENT schemas/protocol.fbs
# and compares it against the two committed hash artefacts:
#
#   rts/Server/ProtocolSchemaHash.h     (server)
#   client/src/protocol/schema-hash.ts  (client)
#
# Both are checked here, not just the C++ one: all four derived artefacts come
# out of a single run of scripts/regen-protocol.sh, so a half-applied regen (or
# a half-resolved merge) is drift no matter which side it landed on, and the
# server build is the one build every developer runs.
#
# Why a hash and not a timestamp/diff of the generated bindings: the .bfbs hash
# is insensitive to comments and formatting in the .fbs by construction, so a
# comment-only schema edit does not demand a regen. See PLAN-protocol-guard §2.2.
#
# Invoked at build time by the `check_protocol_schema` target.
# Inputs (all -D): FLATC SCHEMA CPP_HEADER TS_FILE WORK_DIR STAMP

foreach(var FLATC SCHEMA CPP_HEADER TS_FILE WORK_DIR STAMP)
    if(NOT DEFINED ${var})
        message(FATAL_ERROR "CheckProtocolSchemaHash.cmake: -D${var} is required")
    endif()
endforeach()

set(_regen_msg
    "protocol.fbs changed without regen — run scripts/regen-protocol.sh")

# The .bfbs hash depends on the schema's file BASENAME, so flatc must be run on
# schemas/protocol.fbs itself. Never copy the schema aside to hash it; the same
# bytes under another name hash differently and the guard would fail forever.
get_filename_component(_schema_name ${SCHEMA} NAME_WE)
execute_process(
    COMMAND ${FLATC} -b --schema -o ${WORK_DIR} ${SCHEMA}
    RESULT_VARIABLE _flatc_result
    ERROR_VARIABLE _flatc_err
)
if(NOT _flatc_result EQUAL 0)
    message(FATAL_ERROR
        "check_protocol_schema: flatc failed on ${SCHEMA}\n${_flatc_err}")
endif()

file(SHA256 ${WORK_DIR}/${_schema_name}.bfbs _actual)

# --- the committed C++ header ------------------------------------------------
file(READ ${CPP_HEADER} _cpp_text)
if(NOT _cpp_text MATCHES "SCHEMA_HASH\\[\\] = \"([0-9a-f]+)\"")
    message(FATAL_ERROR
        "check_protocol_schema: no SCHEMA_HASH found in ${CPP_HEADER}\n"
        "${_regen_msg}")
endif()
set(_cpp_hash ${CMAKE_MATCH_1})

# --- the committed client file ----------------------------------------------
file(READ ${TS_FILE} _ts_text)
if(NOT _ts_text MATCHES "SCHEMA_HASH = '([0-9a-f]+)'")
    message(FATAL_ERROR
        "check_protocol_schema: no SCHEMA_HASH found in ${TS_FILE}\n"
        "${_regen_msg}")
endif()
set(_ts_hash ${CMAKE_MATCH_1})

if(NOT _cpp_hash STREQUAL _actual)
    message(FATAL_ERROR
        "check_protocol_schema: ${CPP_HEADER} is stale.\n"
        "  schemas/protocol.fbs hashes to ${_actual}\n"
        "  the committed header says   ${_cpp_hash}\n"
        "${_regen_msg}")
endif()
if(NOT _ts_hash STREQUAL _actual)
    message(FATAL_ERROR
        "check_protocol_schema: ${TS_FILE} is stale.\n"
        "  schemas/protocol.fbs hashes to ${_actual}\n"
        "  the committed client file says ${_ts_hash}\n"
        "${_regen_msg}")
endif()

file(WRITE ${STAMP} "${_actual}\n")
