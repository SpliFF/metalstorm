/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

#ifndef SYNCEDPRIMITIVE_H
#define SYNCEDPRIMITIVE_H

// Server-authoritative model: no sync debugging needed.
// Synced types are plain typedefs.
typedef          bool  SyncedBool;
typedef   signed char  SyncedSchar;
typedef   signed short SyncedSshort;
typedef   signed int   SyncedSint;
typedef unsigned char  SyncedUchar;
typedef unsigned short SyncedUshort;
typedef unsigned int   SyncedUint;
typedef          float SyncedFloat;
typedef         double SyncedDouble;
typedef    long double SyncedLongDouble;

#endif // SYNCEDPRIMITIVE_H
