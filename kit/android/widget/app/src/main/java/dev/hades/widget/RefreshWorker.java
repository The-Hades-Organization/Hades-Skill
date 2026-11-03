package dev.hades.widget;

import android.content.Context;

import androidx.annotation.NonNull;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.ExistingWorkPolicy;
import androidx.work.OneTimeWorkRequest;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import java.util.concurrent.TimeUnit;

/** Atualização periódica (15 min, o mínimo do sistema) e sob demanda (botão do widget). */
public final class RefreshWorker extends Worker {

    private static final String PERIODIC = "hades-widget-periodic";
    private static final String ON_DEMAND = "hades-widget-now";
    static final long PERIOD_MINUTES = 15;

    public RefreshWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        new Refresher(getApplicationContext()).refresh();
        return Result.success();
    }

    static void schedulePeriodic(Context context) {
        PeriodicWorkRequest request = new PeriodicWorkRequest.Builder(RefreshWorker.class, PERIOD_MINUTES,
                TimeUnit.MINUTES).setConstraints(Constraints.NONE).build();
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.KEEP, request);
    }

    static void cancelPeriodic(Context context) {
        WorkManager.getInstance(context).cancelUniqueWork(PERIODIC);
    }

    static void refreshNow(Context context) {
        WorkManager.getInstance(context).enqueueUniqueWork(
                ON_DEMAND, ExistingWorkPolicy.REPLACE, new OneTimeWorkRequest.Builder(RefreshWorker.class).build());
    }
}
