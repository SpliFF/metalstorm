// libspringapi — game-connect transport.
//
// WebRTC removed (GW7). connectRtc is an inert stub pending a WebTransport
// port (see PLAN-game-worker.md). The former libdatachannel implementation
// (peer connection + negotiated control/state data channels + HTTP /api/rtc
// signaling) was deleted along with the server-side WebRTC plane.

#include "springapi/springapi.h"

namespace springapi {

RtcConnectionPtr connectRtc(const std::string& /*serverUrl*/,
                             const std::string& /*authToken*/) {
    return nullptr; // game-connect transport unavailable (WebTransport port pending)
}

} // namespace springapi
