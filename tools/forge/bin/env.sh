# source me (bash or zsh): forge environment. Paths derive from this file.
if [ -n "${BASH_SOURCE:-}" ]; then _forge_src="${BASH_SOURCE[0]}"
elif [ -n "${ZSH_VERSION:-}" ]; then eval '_forge_src=${(%):-%x}'
else _forge_src="$0"; fi
export FORGE="$(cd "$(dirname "$_forge_src")/.." && pwd)"
export TOOLKIT="$(cd "$FORGE/../fable-model-forge" && pwd)"
export PY=$FORGE/venv/bin/python
export PYTHONPATH=$TOOLKIT:$FORGE/prefabs${PYTHONPATH:+:$PYTHONPATH}
unset _forge_src
