import {
  CalendarCheck,
  Gamepad2,
  Rocket,
  Vote,
  Flame,
  Trophy,
  Dices,
  UserPlus,
  Gift,
  Coins,
  Sparkles,
  Star,
  Award,
  Ticket,
  LucideIcon,
} from 'lucide-react';

const map: Record<string, LucideIcon> = {
  CalendarCheck,
  Gamepad2,
  Rocket,
  Vote,
  Flame,
  Trophy,
  Dices,
  UserPlus,
  Gift,
  Coins,
  Sparkles,
  Star,
  Award,
  Ticket,
};

export function ActivityIcon({ name, ...props }: { name?: string } & Record<string, any>) {
  const Icon = (name && map[name]) || Gift;
  return <Icon {...props} />;
}
