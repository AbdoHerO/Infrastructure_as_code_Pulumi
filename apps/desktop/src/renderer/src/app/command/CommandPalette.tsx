import { useNavigate } from 'react-router-dom';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@cloudforge/ui';
import { NAVIGATION } from '../navigation.js';
import { useCommandPalette } from './command-store.js';

/** Global command palette: fuzzy-search and jump to any module. */
export function CommandPalette(): JSX.Element {
  const navigate = useNavigate();
  const open = useCommandPalette((s) => s.open);
  const setOpen = useCommandPalette((s) => s.setOpen);

  const go = (path: string): void => {
    setOpen(false);
    navigate(path);
  };

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Search modules, run a command…" />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        {NAVIGATION.map((group) => (
          <CommandGroup key={group.title} heading={group.title}>
            {group.items.map((item) => (
              <CommandItem
                key={item.path}
                value={`${group.title} ${item.label}`}
                onSelect={() => go(item.path)}
              >
                <item.icon />
                <span>{item.label}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
      </CommandList>
    </CommandDialog>
  );
}
