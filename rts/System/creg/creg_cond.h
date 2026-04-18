/**
 * creg stub — serialisation system removed
 *
 * creg was Spring's custom serialisation system for save/load game state.
 * In the server-authoritative model, state persistence uses SQLite and
 * snapshot serialisation instead. These macros expand to nothing.
 */

#ifndef CREG_COND_H
#define CREG_COND_H

// All creg macros expand to nothing (variadic to handle nested commas)
#define CR_DECLARE(...)
#define CR_DECLARE_DERIVED(...)
#define CR_DECLARE_STRUCT(...)
#define CR_DECLARE_SUB(...)
#define CR_BIND(...)
#define CR_BIND_DERIVED(...)
#define CR_BIND_DERIVED_INTERFACE(...)
#define CR_BIND_DERIVED_INTERFACE_POOL(...)
#define CR_BIND_DERIVED_POOL(...)
#define CR_BIND_DERIVED_SUB(...)
#define CR_BIND_INTERFACE(...)
#define CR_BIND_TEMPLATE(...)
#define CR_REG_METADATA(...)
#define CR_REG_METADATA_SUB(...)
#define CR_REG_METADATA_TEMPLATE(...)
#define CR_MEMBER(...)
#define CR_MEMBER_BEGINFLAG(...)
#define CR_MEMBER_ENDFLAG(...)
#define CR_MEMBER_SETFLAG(...)
#define CR_MEMBER_UN(...)
#define CR_IGNORED(...)
#define CR_SETFLAG(...)
#define CR_POSTLOAD(...)
#define CR_SERIALIZER(...)
#define CR_ENUM_MEMBER(...)

#endif // CREG_COND_H
