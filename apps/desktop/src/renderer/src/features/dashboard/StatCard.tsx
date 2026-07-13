import { motion } from 'framer-motion';
import type { LucideIcon } from 'lucide-react';
import { Card } from '@cloudforge/ui';

interface StatCardProps {
  label: string;
  value: string | number;
  hint: string;
  icon: LucideIcon;
  index: number;
}

/** Animated summary metric tile for the dashboard grid. */
export function StatCard({ label, value, hint, icon: Icon, index }: StatCardProps): JSX.Element {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: index * 0.05 }}
    >
      <Card className="p-5">
        <div className="flex items-center justify-between">
          <p className="text-muted-foreground text-sm font-medium">{label}</p>
          <div className="bg-secondary text-muted-foreground flex size-8 items-center justify-center rounded-lg">
            <Icon className="size-4" />
          </div>
        </div>
        <p className="mt-3 text-3xl font-semibold tracking-tight">{value}</p>
        <p className="text-muted-foreground mt-1 text-xs">{hint}</p>
      </Card>
    </motion.div>
  );
}
