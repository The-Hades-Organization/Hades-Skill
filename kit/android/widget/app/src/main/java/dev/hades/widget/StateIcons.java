package dev.hades.widget;

/** Qual ícone (vector drawable colorido pelos tokens) cada estado do contrato usa. Troca por setImageViewResource. */
final class StateIcons {

    private StateIcons() {
    }

    static int ci(PrsSection.Ci ci) {
        switch (ci) {
            case GREEN:
                return R.drawable.ic_state_ok;
            case FAILING:
                return R.drawable.ic_state_bad;
            case RUNNING:
                return R.drawable.ic_state_run;
            case NONE:
            default:
                return R.drawable.ic_state_idle;
        }
    }

    static int agent(WidgetSnapshot.AgentState state) {
        switch (state) {
            case ASKING:
                return R.drawable.ic_state_warn;
            case ACTIVE:
                return R.drawable.ic_state_active;
            case STOPPED:
            default:
                return R.drawable.ic_state_idle;
        }
    }

    static int health(boolean down) {
        return down ? R.drawable.ic_state_bad : R.drawable.ic_state_ok;
    }
}
