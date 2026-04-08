// RatingSystem — Glicko-2 implementation.

#include "RatingSystem.h"
#include <algorithm>
#include <cmath>

// Convert to Glicko-2 scale
static double toGlicko2(double rating) { return (rating - 1500.0) / 173.7178; }
static double toGlicko2Phi(double phi) { return phi / 173.7178; }
// Convert back
static double fromGlicko2(double mu2) { return mu2 * 173.7178 + 1500.0; }
static double fromGlicko2Phi(double phi2) { return phi2 * 173.7178; }

double RatingSystem::g(double phi) {
    return 1.0 / std::sqrt(1.0 + 3.0 * phi * phi / PI2);
}

double RatingSystem::E(double mu, double muj, double phij) {
    return 1.0 / (1.0 + std::exp(-g(phij) * (mu - muj)));
}

Glicko2Rating RatingSystem::UpdateRating(
    const Glicko2Rating& player,
    const Glicko2Rating& opponent,
    double score)
{
    // Step 1-2: Convert to Glicko-2 scale
    double mu = toGlicko2(player.mu);
    double phi = toGlicko2Phi(player.phi);
    double muj = toGlicko2(opponent.mu);
    double phij = toGlicko2Phi(opponent.phi);

    // Step 3: Compute v (estimated variance)
    double gj = g(phij);
    double Ej = E(mu, muj, phij);
    double v = 1.0 / (gj * gj * Ej * (1.0 - Ej));

    // Step 4: Compute delta
    double delta = v * gj * (score - Ej);

    // Step 5: Determine new volatility (simplified Illinois algorithm)
    double sigma = player.sigma;
    double a = std::log(sigma * sigma);
    double tau2 = TAU * TAU;
    double phi2 = phi * phi;

    // Iterative algorithm to find new sigma
    double A = a;
    double B;
    if (delta * delta > phi2 + v) {
        B = std::log(delta * delta - phi2 - v);
    } else {
        int k = 1;
        B = a - k * TAU;
        while (B < a - 10.0 * TAU) { // safety limit
            k++;
            B = a - k * TAU;
        }
    }

    // Simple bisection (5 iterations is sufficient)
    for (int i = 0; i < 20; i++) {
        double C = (A + B) / 2.0;
        double eC = std::exp(C);
        double f_C = (eC * (delta * delta - phi2 - v - eC)) /
                     (2.0 * (phi2 + v + eC) * (phi2 + v + eC)) - (C - a) / tau2;
        double eA = std::exp(A);
        double f_A = (eA * (delta * delta - phi2 - v - eA)) /
                     (2.0 * (phi2 + v + eA) * (phi2 + v + eA)) - (A - a) / tau2;

        if (f_C * f_A < 0) {
            B = C;
        } else {
            A = C;
        }

        if (std::abs(B - A) < 1e-6) break;
    }

    double newSigma = std::exp((A + B) / 4.0); // geometric mean approximation

    // Step 6: Update phi to new pre-rating period value
    double phiStar = std::sqrt(phi2 + newSigma * newSigma);

    // Step 7: Update rating and RD
    double newPhi = 1.0 / std::sqrt(1.0 / (phiStar * phiStar) + 1.0 / v);
    double newMu = mu + newPhi * newPhi * gj * (score - Ej);

    // Step 8: Convert back
    Glicko2Rating result;
    result.mu = fromGlicko2(newMu);
    result.phi = fromGlicko2Phi(newPhi);
    result.sigma = newSigma;

    // Clamp phi to reasonable range
    result.phi = std::clamp(result.phi, 30.0, 500.0);

    return result;
}

Glicko2Rating RatingSystem::TeamAverage(const std::vector<Glicko2Rating>& ratings) {
    if (ratings.empty()) return {};

    Glicko2Rating avg;
    avg.mu = 0;
    avg.phi = 0;
    avg.sigma = 0;

    for (const auto& r : ratings) {
        avg.mu += r.mu;
        avg.phi += r.phi;
        avg.sigma += r.sigma;
    }

    double n = static_cast<double>(ratings.size());
    avg.mu /= n;
    avg.phi /= n;
    avg.sigma /= n;
    return avg;
}

Glicko2Rating RatingSystem::ApplyInactivityDecay(const Glicko2Rating& rating, int daysInactive) {
    if (daysInactive <= 30) return rating;

    Glicko2Rating result = rating;
    // Increase phi toward 350 (max uncertainty) linearly
    double decayRate = std::min(static_cast<double>(daysInactive - 30) / 180.0, 1.0);
    result.phi = rating.phi + (350.0 - rating.phi) * decayRate;
    return result;
}
