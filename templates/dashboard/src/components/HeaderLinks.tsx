import { Globe, Github, Package } from 'lucide-react';

/**
 * HeaderLinks — OpenBoardCLI project links shown on the left side of the app
 * header. Shell component: never removed or rewritten by dashboard
 * generation; synced from the template on every deploy.
 */
const LINKS = [
  {
    href: 'https://openboard-site.vercel.app/#human',
    label: 'OpenBoardCLI website',
    Icon: Globe,
  },
  {
    href: 'https://github.com/syedateebulislam/openboard',
    label: 'GitHub repository',
    Icon: Github,
  },
  {
    href: 'https://www.npmjs.com/package/openboard-cli',
    label: 'npm package',
    Icon: Package,
  },
] as const;

export function HeaderLinks() {
  return (
    <nav className="header-links" aria-label="OpenBoardCLI project links">
      {LINKS.map(({ href, label, Icon }) => (
        <a
          key={href}
          className="header-link"
          href={href}
          target="_blank"
          rel="noreferrer"
          aria-label={label}
          title={label}
        >
          <Icon size={18} aria-hidden="true" />
        </a>
      ))}
    </nav>
  );
}
