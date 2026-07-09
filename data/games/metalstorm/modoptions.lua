-- Metalstorm setup options (Spring modoptions format — see PLAN-lobby.md §2.2).
-- Tunables back the open design questions in PLAN-metalstorm.md §10.
return {
    {
        key     = 'persistent',
        name    = 'Persistent game',
        desc    = 'Room never self-terminates; players drop in and out',
        type    = 'bool',
        def     = true,
        section = 'world',
    },
    {
        key     = 'authority_reward_scale',
        name    = 'Authority reward scale',
        desc    = 'Multiplier on objective authority rewards',
        type    = 'number',
        def     = 1.0, min = 0.25, max = 4.0, step = 0.25,
        section = 'authority',
    },
    {
        key     = 'authority_cost_scale',
        name    = 'Order cost scale',
        desc    = 'Multiplier on order authority costs (0 = free orders, for testing)',
        type    = 'number',
        def     = 1.0, min = 0.0, max = 4.0, step = 0.25,
        section = 'authority',
    },
    {
        key     = 'objective_density',
        name    = 'Objective density',
        desc    = 'How aggressively systemic objectives are generated',
        type    = 'list',
        def     = 'normal',
        items   = {
            { key = 'sparse', name = 'Sparse' },
            { key = 'normal', name = 'Normal' },
            { key = 'dense',  name = 'Dense'  },
        },
        section = 'objectives',
    },
    {
        key     = 'build_time_scale',
        name    = 'Construction time scale',
        desc    = 'Multiplier on building construction time (1.0 = real-time hours; lower for testing)',
        type    = 'number',
        def     = 1.0, min = 0.01, max = 2.0, step = 0.01,
        section = 'world',
    },
}
