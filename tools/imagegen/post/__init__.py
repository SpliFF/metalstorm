"""imagegen post-processing — seamless offset-blend, PBR derivation (reuses
tools/fable-model-forge's Sobel normal bake), power-of-two resize, ktx2
encoding for terrain. Each module is a pure function over PIL Images/paths
so it works identically regardless of which backend produced the source.
"""
