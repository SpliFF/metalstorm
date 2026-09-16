import { describe, it, expect } from 'vitest';
import { findSection, renderGuide, slugify } from './guide-md';

const MD = `# Guide

Intro *para* with **bold**.

## Getting started

- one <b>x</b>
- two

## Standing

| Tier | Name |
|---|---|
| 0 | Recruit |
`;

describe('renderGuide', () => {
    it('renders headings, lists, tables and escapes markup', () => {
        const { html, sections } = renderGuide(MD);
        expect(sections.map(s => s.id)).toEqual(['getting-started', 'standing']);
        expect(html).toContain('<h2 id="help-standing">Standing</h2>');
        expect(html).toContain('<li>one &lt;b&gt;x&lt;/b&gt;</li>');
        expect(html).toContain('<td>Recruit</td>');
        expect(html).toContain('<em>para</em> with <strong>bold</strong>');
    });

    it('finds a topic by slug, then by containment, else null', () => {
        const { sections } = renderGuide(MD);
        expect(findSection(sections, 'Standing')?.id).toBe('standing');
        expect(findSection(sections, 'start')?.id).toBe('getting-started');
        expect(findSection(sections, 'nothing-here')).toBeNull();
        expect(slugify('The World!')).toBe('the-world');
    });
});
