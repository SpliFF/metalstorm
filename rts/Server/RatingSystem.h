// RatingSystem — Glicko-2 skill rating for matchmaking.
//
// Each player has three values:
//   mu (μ) — estimated skill (default 1500)
//   phi (φ) — rating deviation/uncertainty (default 350)
//   sigma (σ) — volatility (default 0.06)
//
// After each game, ratings are updated based on outcome and
// opponent ratings. Higher deviation = more uncertain = faster adjustment.
#pragma once

#include <cmath>
#include <vector>

struct Glicko2Rating {
    double mu = 1500.0;     // skill estimate
    double phi = 350.0;     // rating deviation
    double sigma = 0.06;    // volatility
};

struct GameResult {
    Glicko2Rating player;
    Glicko2Rating opponent; // team average
    double score;           // 1.0 = win, 0.5 = draw, 0.0 = loss
};

class RatingSystem {
public:
    /// Update a player's rating after a game.
    /// Returns the updated rating.
    static Glicko2Rating UpdateRating(const Glicko2Rating& player,
                                      const Glicko2Rating& opponent,
                                      double score);

    /// Compute team average rating from a list of player ratings.
    static Glicko2Rating TeamAverage(const std::vector<Glicko2Rating>& ratings);

    /// Apply inactivity decay (increases phi toward 350 over time).
    /// daysInactive is the number of days since last game.
    static Glicko2Rating ApplyInactivityDecay(const Glicko2Rating& rating,
                                               int daysInactive);

private:
    static constexpr double TAU = 0.5;     // system constant
    static constexpr double PI2 = M_PI * M_PI;
    static constexpr double GLICKO2_SCALE = 173.7178; // 400/ln(10)

    static double g(double phi);
    static double E(double mu, double muj, double phij);
};
