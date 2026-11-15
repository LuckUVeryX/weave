# Weave agent instructions

- Before adding complexity for a speculative or vanishingly unlikely race or security edge case, explain the concrete failure mode, likelihood, and complexity cost, and get buy-in. Do not silently expand scope for theoretical robustness.
- Validate unknown values once at the boundary that owns them, then pass typed values inward. Do not defensively revalidate values already guaranteed by a schema, constructor, or internal type.
- Test each behavior once at the strongest boundary that observes it. Do not add test-only exports or production code paths solely to support tests.
