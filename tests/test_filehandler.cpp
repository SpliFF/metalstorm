#include <doctest/doctest.h>
#include "System/FileSystem/FileHandler.h"
#include <filesystem>
#include <fstream>

namespace fs = std::filesystem;

static void writeTestFile(const std::string& path, const std::string& content) {
    fs::create_directories(fs::path(path).parent_path());
    std::ofstream f(path);
    f << content;
}

TEST_SUITE("CFileHandler") {
    TEST_CASE("content root resolution") {
        // Setup temp dirs
        auto tmp = fs::temp_directory_path() / "spring-test-fh";
        fs::remove_all(tmp);
        auto root1 = tmp / "game";
        auto root2 = tmp / "map";

        writeTestFile((root1 / "gamedata" / "test.lua").string(), "return 42");
        writeTestFile((root2 / "mapinfo.lua").string(), "return 'map'");

        CFileHandler::ClearContentRoots();
        CFileHandler::AddContentRoot(root1.string());
        CFileHandler::AddContentRoot(root2.string());

        SUBCASE("finds file in first root") {
            CHECK(CFileHandler::FileExists("gamedata/test.lua"));
            CFileHandler fh("gamedata/test.lua");
            CHECK(fh.FileExists());
            std::string data;
            CHECK(fh.LoadStringData(data));
            CHECK(data == "return 42");
        }

        SUBCASE("finds file in second root") {
            CHECK(CFileHandler::FileExists("mapinfo.lua"));
            CFileHandler fh("mapinfo.lua");
            CHECK(fh.FileExists());
        }

        SUBCASE("returns false for missing file") {
            CHECK_FALSE(CFileHandler::FileExists("nonexistent.lua"));
            CFileHandler fh("nonexistent.lua");
            CHECK_FALSE(fh.FileExists());
        }

        SUBCASE("DirList returns files matching pattern") {
            writeTestFile((root1 / "units" / "tank.lua").string(), "");
            writeTestFile((root1 / "units" / "infantry.lua").string(), "");
            writeTestFile((root1 / "units" / "readme.txt").string(), "");

            auto luaFiles = CFileHandler::DirList("units", "*.lua");
            CHECK(luaFiles.size() == 2);

            auto allFiles = CFileHandler::DirList("units", "*");
            CHECK(allFiles.size() == 3);
        }

        SUBCASE("SubDirs returns directories") {
            fs::create_directories(root1 / "units" / "tanks");
            fs::create_directories(root1 / "units" / "infantry");
            writeTestFile((root1 / "units" / "defs.lua").string(), ""); // file, not dir

            auto dirs = CFileHandler::SubDirs("units");
            CHECK(dirs.size() == 2);
        }

        SUBCASE("first root wins for duplicate files") {
            writeTestFile((root1 / "shared.lua").string(), "from_game");
            writeTestFile((root2 / "shared.lua").string(), "from_map");

            CFileHandler fh("shared.lua");
            CHECK(fh.FileExists());
            std::string data;
            fh.LoadStringData(data);
            CHECK(data == "from_game"); // game root added first
        }

        // Cleanup
        CFileHandler::ClearContentRoots();
        fs::remove_all(tmp);
    }

    TEST_CASE("glob matching") {
        CHECK(CFileHandler::FileExists(".", "")); // cwd always exists as dir

        // Test via DirList with a known directory
        auto tmp = fs::temp_directory_path() / "spring-test-glob";
        fs::remove_all(tmp);
        writeTestFile((tmp / "a.lua").string(), "");
        writeTestFile((tmp / "b.lua").string(), "");
        writeTestFile((tmp / "c.txt").string(), "");

        CFileHandler::ClearContentRoots();
        CFileHandler::AddContentRoot(tmp.string());

        auto lua = CFileHandler::DirList(".", "*.lua");
        CHECK(lua.size() == 2);

        auto txt = CFileHandler::DirList(".", "*.txt");
        CHECK(txt.size() == 1);

        auto all = CFileHandler::DirList(".", "*");
        CHECK(all.size() == 3);

        CFileHandler::ClearContentRoots();
        fs::remove_all(tmp);
    }
}
