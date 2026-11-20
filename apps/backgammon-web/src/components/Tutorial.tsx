"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { FocusTrap } from "@/components/ui";

// ── Constants ───────────────────────────────────────────────────

const STORAGE_KEY = "gammon-tutorial-completed";

interface TutorialStep {
  title: string;
  body: string;
  cta: string;
  icon: React.ReactNode;
}

// ── Step Icons (inline SVGs matching the app aesthetic) ──────────

function WelcomeIcon() {
  return (
    <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
      <rect x="8" y="8" width="32" height="32" rx="8" stroke="var(--color-gold-primary)" strokeWidth="2" />
      <circle cx="18" cy="18" r="2.5" fill="var(--color-gold-primary)" />
      <circle cx="30" cy="18" r="2.5" fill="var(--color-gold-primary)" />
      <circle cx="24" cy="24" r="2.5" fill="var(--color-gold-primary)" />
      <circle cx="18" cy="30" r="2.5" fill="var(--color-gold-primary)" />
      <circle cx="30" cy="30" r="2.5" fill="var(--color-gold-primary)" />
    </svg>
  );
}

function BoardIcon() {
  return (
    <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
      <rect x="4" y="8" width="40" height="32" rx="3" stroke="var(--color-gold-primary)" strokeWidth="1.5" />
      <line x1="24" y1="8" x2="24" y2="40" stroke="var(--color-gold-primary)" strokeWidth="1.5" />
      {/* Triangular points */}
      <polygon points="8,8 10,20 12,8" fill="var(--color-gold-primary)" opacity="0.3" />
      <polygon points="14,8 16,20 18,8" fill="var(--color-gold-primary)" opacity="0.5" />
      <polygon points="20,8 22,20 24,8" fill="var(--color-gold-primary)" opacity="0.3" />
      <polygon points="26,8 28,20 30,8" fill="var(--color-gold-primary)" opacity="0.5" />
      <polygon points="32,8 34,20 36,8" fill="var(--color-gold-primary)" opacity="0.3" />
      <polygon points="38,8 40,20 42,8" fill="var(--color-gold-primary)" opacity="0.5" />
      {/* Bottom points */}
      <polygon points="8,40 10,28 12,40" fill="var(--color-gold-primary)" opacity="0.5" />
      <polygon points="14,40 16,28 18,40" fill="var(--color-gold-primary)" opacity="0.3" />
      <polygon points="20,40 22,28 24,40" fill="var(--color-gold-primary)" opacity="0.5" />
    </svg>
  );
}

function DiceIcon() {
  return (
    <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
      <rect x="6" y="10" width="16" height="16" rx="3" stroke="var(--color-gold-primary)" strokeWidth="1.5" />
      <circle cx="11" cy="15" r="1.5" fill="var(--color-gold-primary)" />
      <circle cx="17" cy="15" r="1.5" fill="var(--color-gold-primary)" />
      <circle cx="11" cy="21" r="1.5" fill="var(--color-gold-primary)" />
      <circle cx="17" cy="21" r="1.5" fill="var(--color-gold-primary)" />
      <rect x="26" y="22" width="16" height="16" rx="3" stroke="var(--color-gold-primary)" strokeWidth="1.5" />
      <circle cx="31" cy="27" r="1.5" fill="var(--color-gold-primary)" />
      <circle cx="37" cy="27" r="1.5" fill="var(--color-gold-primary)" />
      <circle cx="34" cy="33" r="1.5" fill="var(--color-gold-primary)" />
      {/* Tap indicator */}
      <circle cx="34" cy="10" r="5" stroke="var(--color-text-muted)" strokeWidth="1" strokeDasharray="2 2" />
      <text x="34" y="13" textAnchor="middle" fill="var(--color-text-muted)" fontSize="8" fontFamily="var(--font-body)">tap</text>
    </svg>
  );
}

function MoveIcon() {
  return (
    <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
      {/* Checker */}
      <circle cx="14" cy="24" r="8" stroke="var(--color-gold-primary)" strokeWidth="1.5" fill="var(--color-bg-elevated)" />
      <circle cx="14" cy="24" r="4" fill="var(--color-gold-primary)" opacity="0.4" />
      {/* Arrow */}
      <path d="M24 24 L36 24" stroke="var(--color-success)" strokeWidth="2" strokeLinecap="round" strokeDasharray="3 3" />
      <path d="M33 20 L37 24 L33 28" stroke="var(--color-success)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      {/* Highlight destination */}
      <circle cx="40" cy="24" r="4" fill="var(--color-success)" opacity="0.25" />
      <circle cx="40" cy="24" r="4" stroke="var(--color-success)" strokeWidth="1" />
    </svg>
  );
}

function BearOffIcon() {
  return (
    <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
      {/* Home board area */}
      <rect x="28" y="10" width="16" height="28" rx="2" stroke="var(--color-gold-primary)" strokeWidth="1.5" strokeDasharray="3 3" />
      <text x="36" y="44" textAnchor="middle" fill="var(--color-text-muted)" fontSize="7" fontFamily="var(--font-body)">1-6</text>
      {/* Checkers bearing off */}
      <circle cx="36" cy="16" r="3" fill="var(--color-gold-primary)" opacity="0.6" />
      <circle cx="36" cy="24" r="3" fill="var(--color-gold-primary)" opacity="0.4" />
      <circle cx="36" cy="32" r="3" fill="var(--color-gold-primary)" opacity="0.2" />
      {/* Arrow out */}
      <path d="M36 10 L36 4" stroke="var(--color-success)" strokeWidth="2" strokeLinecap="round" />
      <path d="M33 7 L36 3 L39 7" stroke="var(--color-success)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      {/* Trophy */}
      <path d="M10 14 L10 22 Q10 28 16 28 Q22 28 22 22 L22 14 Z" stroke="var(--color-gold-primary)" strokeWidth="1.5" fill="none" />
      <line x1="16" y1="28" x2="16" y2="32" stroke="var(--color-gold-primary)" strokeWidth="1.5" />
      <line x1="12" y1="32" x2="20" y2="32" stroke="var(--color-gold-primary)" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

// ── Tap Animation (used in Step 4) ──────────────────────────────

function TapAnimation() {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        margin: "16px 0 4px",
        padding: "12px 16px",
        borderRadius: 8,
        background: "var(--color-bg-deepest)",
        border: "1px solid var(--color-border-subtle)",
      }}
    >
      {/* Checker */}
      <div
        className="tutorial-tap-checker"
        style={{
          width: 28,
          height: 28,
          borderRadius: "50%",
          border: "2px solid var(--color-gold-primary)",
          background: "var(--color-bg-elevated)",
          flexShrink: 0,
        }}
      />
      {/* Arrow */}
      <svg width="32" height="12" viewBox="0 0 32 12" fill="none" style={{ flexShrink: 0 }}>
        <path d="M2 6 L26 6" stroke="var(--color-text-muted)" strokeWidth="1.5" strokeDasharray="3 2" />
        <path d="M22 2 L28 6 L22 10" stroke="var(--color-text-muted)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {/* Destination */}
      <div
        className="tutorial-tap-dest"
        style={{
          width: 28,
          height: 28,
          borderRadius: "50%",
          border: "2px solid var(--color-success)",
          background: "var(--color-success-muted)",
          flexShrink: 0,
        }}
      />
    </div>
  );
}

// ── Steps Definition ────────────────────────────────────────────

const STEPS: TutorialStep[] = [
  {
    title: "Welcome to Gammon!",
    body: "Learn the basics in 30 seconds.",
    cta: "Start Tutorial",
    icon: <WelcomeIcon />,
  },
  {
    title: "The Board",
    body: "The board has 24 triangular points. Your checkers start in this arrangement. Move all 15 of your checkers to your home board, then bear them off to win.",
    cta: "Next",
    icon: <BoardIcon />,
  },
  {
    title: "Rolling Dice",
    body: "Tap \u2018Roll\u2019 on your turn. Each die tells you how many points to move a checker.",
    cta: "Next",
    icon: <DiceIcon />,
  },
  {
    title: "Moving Checkers",
    body: "Tap a checker to select it, then tap a highlighted point to move it. Green highlights show legal moves.",
    cta: "Next",
    icon: <MoveIcon />,
  },
  {
    title: "Bearing Off & Winning",
    body: "Once all your checkers are in your home board (points 1\u20136), you can bear them off. First to bear off all checkers wins!",
    cta: "Got it!",
    icon: <BearOffIcon />,
  },
];

// ── Tutorial Component ──────────────────────────────────────────

interface TutorialProps {
  /** Force the tutorial to show (used for "Replay Tutorial" in settings) */
  forceShow?: boolean;
  /** Called when the tutorial is dismissed */
  onClose?: () => void;
}

export default function Tutorial({ forceShow = false, onClose }: TutorialProps) {
  const [visible, setVisible] = useState(false);
  const [step, setStep] = useState(0);
  const [direction, setDirection] = useState<"next" | "prev">("next");
  const [animating, setAnimating] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  // Check localStorage on mount
  useEffect(() => {
    if (forceShow) {
      setVisible(true);
      setStep(0);
      return;
    }
    try {
      const completed = localStorage.getItem(STORAGE_KEY);
      if (completed !== "true") {
        setVisible(true);
      }
    } catch {
      // localStorage not available, show tutorial
      setVisible(true);
    }
  }, [forceShow]);

  const dismiss = useCallback(() => {
    setVisible(false);
    try {
      localStorage.setItem(STORAGE_KEY, "true");
    } catch {
      // ignore
    }
    onClose?.();
  }, [onClose]);

  const goToStep = useCallback(
    (nextStep: number) => {
      if (animating) return;
      setDirection(nextStep > step ? "next" : "prev");
      setAnimating(true);
      // Brief delay to trigger CSS transition
      setTimeout(() => {
        setStep(nextStep);
        setAnimating(false);
      }, 200);
    },
    [step, animating],
  );

  const handleNext = useCallback(() => {
    if (step < STEPS.length - 1) {
      goToStep(step + 1);
    } else {
      dismiss();
    }
  }, [step, goToStep, dismiss]);

  const handleBack = useCallback(() => {
    if (step > 0) {
      goToStep(step - 1);
    }
  }, [step, goToStep]);

  // Keyboard navigation
  useEffect(() => {
    if (!visible) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === "Enter") {
        e.preventDefault();
        handleNext();
      } else if (e.key === "ArrowLeft" && step > 0) {
        e.preventDefault();
        handleBack();
      } else if (e.key === "Escape") {
        e.preventDefault();
        dismiss();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [visible, step, handleNext, handleBack, dismiss]);

  if (!visible) return null;

  const currentStep = STEPS[step];
  const isFirstStep = step === 0;
  const isLastStep = step === STEPS.length - 1;

  return (
    <>
      {/* Inject keyframe animations via a style element */}
      <style>{`
        @keyframes tutorial-fade-in {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes tutorial-card-enter {
          from { opacity: 0; transform: translateY(16px) scale(0.97); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes tutorial-step-next {
          from { opacity: 0; transform: translateX(24px); }
          to { opacity: 1; transform: translateX(0); }
        }
        @keyframes tutorial-step-prev {
          from { opacity: 0; transform: translateX(-24px); }
          to { opacity: 1; transform: translateX(0); }
        }
        @keyframes tutorial-step-exit {
          from { opacity: 1; }
          to { opacity: 0; }
        }
        @keyframes tutorial-tap-pulse {
          0%, 100% { box-shadow: 0 0 0 0 transparent; transform: scale(1); }
          50% { box-shadow: 0 0 0 6px var(--color-success-muted); transform: scale(1.08); }
        }
        @keyframes tutorial-checker-pulse {
          0%, 100% { box-shadow: 0 0 0 0 var(--color-gold-muted); transform: scale(1); }
          50% { box-shadow: 0 0 0 4px var(--color-gold-primary); transform: scale(1.06); }
        }
        .tutorial-tap-checker {
          animation: tutorial-checker-pulse 2s ease-in-out infinite;
        }
        .tutorial-tap-dest {
          animation: tutorial-tap-pulse 2s ease-in-out 0.5s infinite;
        }
        @media (prefers-reduced-motion: reduce) {
          .tutorial-tap-checker,
          .tutorial-tap-dest {
            animation: none !important;
          }
        }
      `}</style>

      <FocusTrap active={visible} onEscape={dismiss}>
        {/* Backdrop */}
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Game tutorial"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 9999,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "var(--color-overlay)",
            padding: 16,
            animation: "tutorial-fade-in 300ms ease-out",
          }}
          onClick={(e) => {
            // Click outside card to dismiss
            if (e.target === e.currentTarget) dismiss();
          }}
        >
          {/* Card */}
          <div
            style={{
              position: "relative",
              width: "100%",
              maxWidth: 400,
              background: "var(--color-bg-surface)",
              border: "1px solid var(--color-border-subtle)",
              borderRadius: 12,
              boxShadow: "var(--shadow-elevated)",
              overflow: "hidden",
              animation: "tutorial-card-enter 400ms cubic-bezier(0.22, 1, 0.36, 1)",
            }}
          >
            {/* Skip button (top right) */}
            {!isLastStep && (
              <button
                onClick={dismiss}
                aria-label="Skip tutorial"
                style={{
                  position: "absolute",
                  top: 16,
                  right: 16,
                  background: "none",
                  border: "none",
                  fontSize: "0.75rem",
                  fontWeight: 600,
                  color: "var(--color-text-muted)",
                  cursor: "pointer",
                  fontFamily: "var(--font-body)",
                  padding: "4px 8px",
                  borderRadius: 4,
                  zIndex: 2,
                  transition: "color 0.15s ease",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.color = "var(--color-text-secondary)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.color = "var(--color-text-muted)";
                }}
              >
                Skip
              </button>
            )}

            {/* Content area */}
            <div
              ref={contentRef}
              key={step}
              style={{
                padding: "36px 28px 24px",
                textAlign: "center",
                animation: animating
                  ? "tutorial-step-exit 200ms ease-out forwards"
                  : direction === "next"
                    ? "tutorial-step-next 300ms ease-out"
                    : "tutorial-step-prev 300ms ease-out",
              }}
            >
              {/* Icon */}
              <div
                style={{
                  display: "flex",
                  justifyContent: "center",
                  marginBottom: 20,
                }}
              >
                {currentStep.icon}
              </div>

              {/* Title */}
              <h2
                style={{
                  fontFamily: "var(--font-display)",
                  fontSize: "1.5rem",
                  fontWeight: 700,
                  color: "var(--color-text-primary)",
                  margin: "0 0 10px",
                  lineHeight: 1.2,
                }}
              >
                {currentStep.title}
              </h2>

              {/* Body */}
              <p
                style={{
                  fontFamily: "var(--font-body)",
                  fontSize: "0.875rem",
                  lineHeight: 1.6,
                  color: "var(--color-text-secondary)",
                  margin: 0,
                  maxWidth: 320,
                  marginLeft: "auto",
                  marginRight: "auto",
                }}
              >
                {currentStep.body}
              </p>

              {/* Tap animation for step 4 (Moving Checkers) */}
              {step === 3 && <TapAnimation />}
            </div>

            {/* Footer: dots + buttons */}
            <div
              style={{
                padding: "0 28px 28px",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 20,
              }}
            >
              {/* Step indicator dots */}
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  justifyContent: "center",
                }}
                aria-label={`Step ${step + 1} of ${STEPS.length}`}
              >
                {STEPS.map((_, i) => (
                  <button
                    key={i}
                    onClick={() => goToStep(i)}
                    aria-label={`Go to step ${i + 1}`}
                    style={{
                      width: i === step ? 20 : 8,
                      height: 8,
                      borderRadius: 4,
                      border: "none",
                      cursor: "pointer",
                      padding: 0,
                      background:
                        i === step
                          ? "var(--color-gold-primary)"
                          : "var(--color-bg-subtle)",
                      transition: "all 0.25s ease",
                    }}
                  />
                ))}
              </div>

              {/* Action buttons */}
              <div
                style={{
                  display: "flex",
                  gap: 10,
                  width: "100%",
                }}
              >
                {/* Back button (shown after step 1) */}
                {!isFirstStep && (
                  <button
                    onClick={handleBack}
                    style={{
                      flex: 0,
                      padding: "12px 20px",
                      borderRadius: 8,
                      border: "1px solid var(--color-border-subtle)",
                      background: "transparent",
                      color: "var(--color-text-secondary)",
                      fontSize: "0.875rem",
                      fontWeight: 600,
                      cursor: "pointer",
                      fontFamily: "var(--font-body)",
                      transition: "all 0.15s ease",
                      whiteSpace: "nowrap",
                      minHeight: 44,
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.borderColor = "var(--color-gold-primary)";
                      e.currentTarget.style.color = "var(--color-text-primary)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.borderColor = "var(--color-border-subtle)";
                      e.currentTarget.style.color = "var(--color-text-secondary)";
                    }}
                  >
                    Back
                  </button>
                )}

                {/* Primary CTA */}
                <button
                  onClick={handleNext}
                  style={{
                    flex: 1,
                    padding: "12px 20px",
                    borderRadius: 8,
                    border: "none",
                    background: "var(--color-gold-primary)",
                    color: "var(--color-accent-fg)",
                    fontSize: "0.875rem",
                    fontWeight: 700,
                    cursor: "pointer",
                    fontFamily: "var(--font-body)",
                    transition: "all 0.15s ease",
                    minHeight: 44,
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "var(--color-gold-light)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "var(--color-gold-primary)";
                  }}
                >
                  {currentStep.cta}
                </button>

                {/* Skip button on first step (alongside Start Tutorial) */}
                {isFirstStep && (
                  <button
                    onClick={dismiss}
                    style={{
                      flex: 0,
                      padding: "12px 20px",
                      borderRadius: 8,
                      border: "1px solid var(--color-border-subtle)",
                      background: "transparent",
                      color: "var(--color-text-muted)",
                      fontSize: "0.875rem",
                      fontWeight: 600,
                      cursor: "pointer",
                      fontFamily: "var(--font-body)",
                      transition: "all 0.15s ease",
                      whiteSpace: "nowrap",
                      minHeight: 44,
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.color = "var(--color-text-secondary)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.color = "var(--color-text-muted)";
                    }}
                  >
                    Skip
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </FocusTrap>
    </>
  );
}
