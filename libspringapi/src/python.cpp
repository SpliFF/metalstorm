// libspringapi Python bindings via pybind11.
//
// Usage:
//   import pyspringapi as api
//   auth = api.login("http://localhost:8011", "test1", "test")
//   result = api.exec("http://localhost:9100", "server", "state", auth.token)
//   print(result.output)

#include <pybind11/pybind11.h>
#include <pybind11/stl.h>
#include <pybind11/functional.h>
#include "springapi/springapi.h"

namespace py = pybind11;

PYBIND11_MODULE(pyspringapi, m) {
    m.doc() = "Spring RTS Web client library";

    // Auth result
    py::class_<springapi::AuthResult>(m, "AuthResult")
        .def_readonly("success", &springapi::AuthResult::success)
        .def_readonly("token", &springapi::AuthResult::token)
        .def_readonly("error", &springapi::AuthResult::error)
        .def_readonly("user_id", &springapi::AuthResult::userId)
        .def_readonly("username", &springapi::AuthResult::username)
        .def_readonly("role", &springapi::AuthResult::role);

    // Exec result
    py::class_<springapi::ExecResult>(m, "ExecResult")
        .def_readonly("success", &springapi::ExecResult::success)
        .def_readonly("output", &springapi::ExecResult::output);

    // HTTP API
    m.def("login", &springapi::login, "Login to a server",
          py::arg("server_url"), py::arg("username"), py::arg("password"));
    m.def("register_user", &springapi::registerUser,
          "Register a new account. `faction` is optional passthrough — send one "
          "when the server requires it (Metalstorm lobbies do); valid keys come "
          "from GET /api/factions/<game_id>.",
          py::arg("server_url"), py::arg("username"), py::arg("password"),
          py::arg("faction") = "");
    m.def("exec", &springapi::exec, "Execute a command",
          py::arg("server_url"), py::arg("scope"), py::arg("code"), py::arg("token"));
    m.def("get_logs", &springapi::getLogs, "Query logs",
          py::arg("log_server_url"), py::arg("room_id") = 0,
          py::arg("level") = 0, py::arg("limit") = 50,
          py::arg("section") = "", py::arg("scope") = "");
    m.def("search_logs", &springapi::searchLogs, "Search logs",
          py::arg("log_server_url"), py::arg("query"),
          py::arg("level") = 0, py::arg("limit") = 50);
    m.def("get_processes", &springapi::getProcesses, "List game servers",
          py::arg("lobby_url"));
    m.def("http_get", &springapi::httpGet, "Raw HTTP GET",
          py::arg("url"));
    m.def("http_post", &springapi::httpPost, "Raw HTTP POST",
          py::arg("url"), py::arg("json_body"), py::arg("auth_token") = "");

    // JSON helpers
    m.def("json_extract", &springapi::jsonExtract, "Extract a JSON field",
          py::arg("json"), py::arg("key"));
    m.def("json_escape", &springapi::jsonEscape, "Escape a string for JSON",
          py::arg("s"));
}
