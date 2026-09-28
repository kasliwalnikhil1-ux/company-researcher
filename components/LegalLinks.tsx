'use client';

import { Fragment } from 'react';
import type { LegalLink } from '@/lib/whitelabel';

/** Renders "A, B, and C" as links, from the domain's whitelabel legalLinks. */
export function LegalLinks({ links }: { links: LegalLink[] }) {
  return (
    <>
      {links.map((link, i) => (
        <Fragment key={link.href}>
          {i > 0 && (i === links.length - 1 ? (links.length > 2 ? ', and ' : ' and ') : ', ')}
          <a
            href={link.href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-brand-default hover:text-brand-dark underline"
          >
            {link.label}
          </a>
        </Fragment>
      ))}
    </>
  );
}
