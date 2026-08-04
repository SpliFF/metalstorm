/**
 * command-composer.test.ts — Basic tests for command-composer widget
 *
 * Note: Full DOM interaction tests would require jsdom, which is not installed.
 * These tests verify the widget's interface contract.
 */

import { describe, it, expect } from 'vitest';

describe('command-composer widget', () => {
    it('should export widget interface', async () => {
        // Dynamically import the widget
        const module = await import('./command-composer.js');
        const widget = module.default;

        expect(widget).toBeDefined();
        expect(widget.id).toBe('command-composer');
        expect(typeof widget.init).toBe('function');
        expect(typeof widget.dispose).toBe('function');
    });

    it('should validate widget follows contract', async () => {
        const module = await import('./command-composer.js');
        const widget = module.default;

        // Widget must have id, init, dispose
        expect(widget.id).toBeDefined();
        expect(widget.init).toBeDefined();
        expect(widget.dispose).toBeDefined();

        // Verify they are functions
        expect(typeof widget.init).toBe('function');
        expect(typeof widget.dispose).toBe('function');

        // Verify id is a string
        expect(typeof widget.id).toBe('string');
    });
});
