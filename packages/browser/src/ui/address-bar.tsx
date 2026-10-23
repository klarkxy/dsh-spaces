import React, { type ReactElement } from 'react';

export interface BrowserAddressBarProps {
  value: string;
  placeholder: string;
  externalUrl: string | null;
  /** A navigation is in flight: the progress bar runs. */
  pending: boolean;
  onChange(value: string): void;
  onSubmit(): void;
}

/**
 * The address bar.
 *
 * The progress bar is absolutely positioned inside the form, so it never
 * changes the height of the page area below it.
 */
export function BrowserAddressBar({ value, placeholder, externalUrl, pending, onChange, onSubmit }: BrowserAddressBarProps): ReactElement {
  return <form className="dsh-browser-address" onSubmit={event => { event.preventDefault(); onSubmit(); }}>
    <input aria-label="Address" value={value} onChange={event => onChange(event.currentTarget.value)}
      placeholder={placeholder} className="dsh-browser-input" />
    <button type="submit" className="dsh-browser-button">Open new tab</button>
    {externalUrl && <a href={externalUrl} target="_blank" rel="noopener noreferrer" className="dsh-browser-link">Open externally</a>}
    {pending && <div className="dsh-browser-progress" aria-hidden="true"><span className="dsh-browser-progress-bar" /></div>}
  </form>;
}
