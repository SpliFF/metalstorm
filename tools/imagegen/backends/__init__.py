"""imagegen backends — each module exposes one function:

    generate(prompt, seed, size, negative, *, asset_class="texture", params=None) -> bytes

`size` is (width, height); the return value is PNG-encoded bytes. `prompt`/
`negative` already carry the style.json class prefix (run.py builds them).
`asset_class` + `params` (the job's extra fields — colors/tint/cols/rows/...)
are hints the `none` backend uses to fake class-appropriate art since it has
no model to interpret the prompt; comfy_local/hosted ignore them and rely on
the prompt text alone, same as a real image model would.
"""
