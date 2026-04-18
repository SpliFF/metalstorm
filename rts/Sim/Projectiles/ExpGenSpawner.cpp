/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

#include "ExpGenSpawner.h"

#include "ExpGenSpawnableMemberInfo.h"
#include "ExplosionGenerator.h"

CR_BIND_DERIVED(CExpGenSpawner, CProjectile, )
CR_REG_METADATA(CExpGenSpawner,
(
	CR_MEMBER_BEGINFLAG(CM_Config),
		CR_MEMBER(delay),
		CR_MEMBER(damage),
		CR_IGNORED(explosionGenerator),
	CR_MEMBER_ENDFLAG(CM_Config),
	CR_SERIALIZER(Serialize)
))


CExpGenSpawner::CExpGenSpawner() : CProjectile()
{
	checkCol = false;
	deleteMe = false;
}

void CExpGenSpawner::Serialize(void* /*s*/) {
	// creg serialization removed (server-authoritative model uses SQLite snapshots)
}

void CExpGenSpawner::Update()
{
	if ((deleteMe |= ((delay--) <= 0)))
		explosionGenerator->Explosion(pos, dir,  damage, 0.0f, 0.0f,  owner(), nullptr);
}


bool CExpGenSpawner::GetMemberInfo(SExpGenSpawnableMemberInfo& memberInfo)
{
	if (CProjectile::GetMemberInfo(memberInfo))
		return true;

	CHECK_MEMBER_INFO_INT  (CExpGenSpawner, delay )
	CHECK_MEMBER_INFO_FLOAT(CExpGenSpawner, damage)
	// TODO: much nicer to load cegID directly via LoadGeneratorID callback
	CHECK_MEMBER_INFO_PTR  (CExpGenSpawner, explosionGenerator, explGenHandler.LoadGenerator)

	return false;
}
