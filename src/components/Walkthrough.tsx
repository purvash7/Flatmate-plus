import React, { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, Compass, Heart, MessageCircle, Settings, Sparkles, User, X } from 'lucide-react';

interface WalkthroughProps {
  onComplete: () => void;
}

interface TourStep {
  title: string;
  body: string;
  icon: React.ReactNode;
  selectors: string[];
}

const STEPS: TourStep[] = [
  {
    title: 'Discover compatible flatmates',
    body: 'Browse people who match your housing preferences and lifestyle. Use the like or pass buttons to tell FlatMate+ who you want to meet.',
    icon: <Compass className="w-5 h-5" />,
    selectors: ['#swipe-like-btn']
  },
  {
    title: 'Fine-tune your search',
    body: 'Use filters to narrow down the people you see by the things that matter to you, like location, budget and preferences.',
    icon: <Sparkles className="w-5 h-5" />,
    selectors: ['#open-filters-btn']
  },
  {
    title: 'Matches & Chat',
    body: 'When the interest is mutual, you get a match. Head here to see your matches and start a conversation before deciding whether to meet.',
    icon: <MessageCircle className="w-5 h-5" />,
    selectors: ['#nav-btn-matches', '#mobile-nav-matches']
  },
  {
    title: 'Your profile',
    body: 'Your profile helps potential flatmates understand your lifestyle, interests and what you are looking for. You can edit it anytime.',
    icon: <User className="w-5 h-5" />,
    selectors: ['#nav-btn-profile', '#mobile-nav-profile']
  },
  {
    title: 'Settings & privacy',
    body: 'Manage notifications, account preferences and other settings from here.',
    icon: <Settings className="w-5 h-5" />,
    selectors: ['#nav-btn-settings', '#mobile-nav-settings']
  }
];

const getVisibleTarget = (selectors: string[]) => {
  for (const selector of selectors) {
    const nodes = Array.from(document.querySelectorAll<HTMLElement>(selector));
    const visible = nodes.find(node => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility !== 'hidden';
    });
    if (visible) return visible;
  }
  return null;
};

export const Walkthrough: React.FC<WalkthroughProps> = ({ onComplete }) => {
  const [stepIndex, setStepIndex] = useState(0);
  const [targetRect, setTargetRect] = useState<DOMRect | null>(null);

  const step = STEPS[stepIndex];
  const isLast = stepIndex === STEPS.length - 1;

  const finish = () => onComplete();

  const updateTarget = () => {
    const target = getVisibleTarget(step.selectors);
    if (!target) {
      setTargetRect(null);
      return;
    }
    const rect = target.getBoundingClientRect();
    setTargetRect(rect);
  };

  useEffect(() => {
    const target = getVisibleTarget(step.selectors);
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
      window.setTimeout(updateTarget, 250);
    } else {
      updateTarget();
    }

    const handleViewportChange = () => updateTarget();
    window.addEventListener('resize', handleViewportChange);
    window.addEventListener('scroll', handleViewportChange, true);
    return () => {
      window.removeEventListener('resize', handleViewportChange);
      window.removeEventListener('scroll', handleViewportChange, true);
    };
  }, [stepIndex]);

  const tooltipStyle = useMemo<React.CSSProperties>(() => {
    if (!targetRect) {
      return {
        left: '50%',
        top: '50%',
        transform: 'translate(-50%, -50%)',
        width: 'min(420px, calc(100vw - 32px))'
      };
    }

    const margin = 16;
    const width = Math.min(380, window.innerWidth - 32);
    const spaceBelow = window.innerHeight - targetRect.bottom;
    const top = spaceBelow >= 220
      ? targetRect.bottom + margin
      : Math.max(16, targetRect.top - 220 - margin);
    const rawLeft = targetRect.left + targetRect.width / 2 - width / 2;
    const left = Math.max(16, Math.min(rawLeft, window.innerWidth - width - 16));

    return { top, left, width };
  }, [targetRect]);

  const next = () => {
    if (isLast) {
      finish();
      return;
    }
    setStepIndex(value => value + 1);
  };

  return (
    <div className="fixed inset-0 z-[100]">
      <div className="absolute inset-0 bg-[#2B2D42]/55 backdrop-blur-[1px]" />

      {targetRect && (
        <div
          className="absolute rounded-2xl border-2 border-[#E07A5F] bg-transparent pointer-events-none transition-all duration-200"
          style={{
            top: Math.max(4, targetRect.top - 6),
            left: Math.max(4, targetRect.left - 6),
            width: targetRect.width + 12,
            height: targetRect.height + 12,
            boxShadow: '0 0 0 9999px rgba(43,45,66,0.48)'
          }}
        />
      )}

      <div
        className="absolute bg-white rounded-3xl border border-[#E6E3DE] shadow-2xl p-5 sm:p-6 transition-all duration-200"
        style={tooltipStyle}
        role="dialog"
        aria-modal="true"
        aria-label={step.title}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="w-10 h-10 rounded-2xl bg-[#E07A5F]/10 text-[#E07A5F] flex items-center justify-center shrink-0">
            {step.icon}
          </div>
          <button
            type="button"
            onClick={finish}
            className="w-8 h-8 rounded-full bg-[#FAF8F4] text-[#7A7D87] flex items-center justify-center hover:text-[#2B2D42]"
            aria-label="Skip walkthrough"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="mt-4">
          <div className="text-[10px] font-black uppercase tracking-[0.16em] text-[#E07A5F]">
            {stepIndex + 1} of {STEPS.length}
          </div>
          <h2 className="font-display font-black text-xl text-[#2B2D42] mt-1">{step.title}</h2>
          <p className="text-sm text-[#7A7D87] leading-relaxed mt-2">{step.body}</p>
        </div>

        <div className="flex items-center justify-between gap-3 mt-6">
          <button
            type="button"
            onClick={stepIndex === 0 ? finish : () => setStepIndex(value => value - 1)}
            className="px-3 py-2.5 rounded-xl text-sm font-bold text-[#7A7D87] hover:text-[#2B2D42] flex items-center gap-1.5"
          >
            {stepIndex === 0 ? 'Skip' : <><ArrowLeft className="w-4 h-4" /> Back</>}
          </button>
          <button
            type="button"
            onClick={next}
            className="px-5 py-2.5 rounded-xl bg-[#E07A5F] text-white text-sm font-bold hover:bg-[#D4694E] shadow-sm flex items-center gap-2"
          >
            {isLast ? 'Start exploring' : 'Next'}
            {!isLast && <ArrowRight className="w-4 h-4" />}
            {isLast && <Heart className="w-4 h-4 fill-current" />}
          </button>
        </div>
      </div>
    </div>
  );
};
