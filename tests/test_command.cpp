#include <doctest/doctest.h>
#include "Sim/Units/CommandAI/Command.h"

TEST_SUITE("Command") {
    TEST_CASE("default constructor") {
        Command cmd;
        CHECK(cmd.GetID() == 0);
        CHECK(cmd.GetNumParams() == 0);
        CHECK(cmd.GetOpts() == 0);
        CHECK(cmd.GetTimeOut() == INT_MAX);
    }

    TEST_CASE("construct with ID") {
        Command cmd(CMD_MOVE);
        CHECK(cmd.GetID() == CMD_MOVE);
        CHECK(cmd.GetNumParams() == 0);
    }

    TEST_CASE("construct with ID and options") {
        Command cmd(CMD_ATTACK, SHIFT_KEY);
        CHECK(cmd.GetID() == CMD_ATTACK);
        CHECK(cmd.GetOpts() == SHIFT_KEY);
        CHECK(cmd.IsInternalOrder() == false);
    }

    TEST_CASE("push and get params") {
        Command cmd(CMD_MOVE);
        cmd.PushParam(1.0f);
        cmd.PushParam(2.0f);
        cmd.PushParam(3.0f);

        CHECK(cmd.GetNumParams() == 3);
        CHECK(cmd.GetParam(0) == doctest::Approx(1.0f));
        CHECK(cmd.GetParam(1) == doctest::Approx(2.0f));
        CHECK(cmd.GetParam(2) == doctest::Approx(3.0f));
    }

    TEST_CASE("push position") {
        float3 pos(100.0f, 50.0f, 200.0f);
        Command cmd(CMD_MOVE);
        cmd.PushPos(pos);

        CHECK(cmd.GetNumParams() == 3);
        float3 result = cmd.GetPos(0);
        CHECK(result.x == doctest::Approx(100.0f));
        CHECK(result.y == doctest::Approx(50.0f));
        CHECK(result.z == doctest::Approx(200.0f));
    }

    TEST_CASE("construct with ID and position") {
        float3 pos(10.0f, 20.0f, 30.0f);
        Command cmd(CMD_MOVE, 0, pos);

        CHECK(cmd.GetID() == CMD_MOVE);
        CHECK(cmd.GetNumParams() == 3);
        float3 result = cmd.GetPos(0);
        CHECK(result.x == doctest::Approx(10.0f));
    }

    TEST_CASE("set and get position") {
        Command cmd(CMD_MOVE);
        cmd.PushPos(float3(0.0f, 0.0f, 0.0f));

        float3 newPos(42.0f, 43.0f, 44.0f);
        cmd.SetPos(0, newPos);

        float3 result = cmd.GetPos(0);
        CHECK(result.x == doctest::Approx(42.0f));
        CHECK(result.y == doctest::Approx(43.0f));
        CHECK(result.z == doctest::Approx(44.0f));
    }

    TEST_CASE("IsMoveCommand") {
        CHECK(Command(CMD_MOVE).IsMoveCommand());
        CHECK(Command(CMD_ATTACK).IsMoveCommand());
        CHECK(Command(CMD_PATROL).IsMoveCommand());
        CHECK(Command(CMD_FIGHT).IsMoveCommand());
        CHECK_FALSE(Command(CMD_STOP).IsMoveCommand());
        CHECK_FALSE(Command(CMD_WAIT).IsMoveCommand());
    }

    TEST_CASE("IsAttackCommand") {
        CHECK(Command(CMD_ATTACK).IsAttackCommand());
        CHECK(Command(CMD_AREA_ATTACK).IsAttackCommand());
        CHECK(Command(CMD_FIGHT).IsAttackCommand());
        CHECK_FALSE(Command(CMD_MOVE).IsAttackCommand());
    }

    TEST_CASE("IsBuildCommand") {
        // Negative IDs are build commands (cmd -x = unitdefs[x])
        CHECK(Command(-1).IsBuildCommand());
        CHECK(Command(-100).IsBuildCommand());
        CHECK_FALSE(Command(CMD_MOVE).IsBuildCommand());
        CHECK_FALSE(Command(0).IsBuildCommand());
    }

    TEST_CASE("IsEmptyCommand") {
        Command cmd(CMD_STOP);
        CHECK(cmd.IsEmptyCommand());

        cmd.PushParam(1.0f);
        CHECK_FALSE(cmd.IsEmptyCommand());
    }

    TEST_CASE("internal order flag") {
        Command cmd(CMD_MOVE, INTERNAL_ORDER);
        CHECK(cmd.IsInternalOrder());

        Command cmd2(CMD_MOVE, SHIFT_KEY);
        CHECK_FALSE(cmd2.IsInternalOrder());
    }

    TEST_CASE("copy constructor") {
        Command orig(CMD_ATTACK, SHIFT_KEY);
        orig.PushPos(float3(1.0f, 2.0f, 3.0f));
        orig.SetTag(42);

        Command copy(orig);
        CHECK(copy.GetID() == CMD_ATTACK);
        CHECK(copy.GetOpts() == SHIFT_KEY);
        CHECK(copy.GetTag() == 42);
        CHECK(copy.GetNumParams() == 3);
        CHECK(copy.GetParam(0) == doctest::Approx(1.0f));
    }

    TEST_CASE("MAX_COMMAND_PARAMS inline storage") {
        Command cmd(CMD_MOVE);
        for (int i = 0; i < MAX_COMMAND_PARAMS; i++) {
            CHECK(cmd.PushParam(static_cast<float>(i)));
        }
        CHECK(cmd.GetNumParams() == MAX_COMMAND_PARAMS);
        for (int i = 0; i < MAX_COMMAND_PARAMS; i++) {
            CHECK(cmd.GetParam(i) == doctest::Approx(static_cast<float>(i)));
        }
    }
}
