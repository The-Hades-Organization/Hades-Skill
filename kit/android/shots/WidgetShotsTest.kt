package dev.hades.widget

import android.content.Context
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.RemoteViews
import app.cash.paparazzi.DeviceConfig
import app.cash.paparazzi.Paparazzi
import com.android.resources.NightMode
import com.android.ide.common.rendering.api.SessionParams
import org.junit.Rule
import org.junit.Test
import java.time.ZoneOffset

/**
 * Renderiza cada widget (layout real + bind real, via RemoteViews.apply) em layoutlib: claro e escuro, compacto e
 * regular, com dado completo, em alerta, carregando e com erro. Só roda por `build.sh shots`; não faz parte dos testes.
 */
class WidgetShotsTest {

    @get:Rule
    val paparazzi = Paparazzi(
        deviceConfig = DeviceConfig.PIXEL_5.copy(nightMode = NightMode.NOTNIGHT),
        theme = "android:Theme.Material.Light.NoActionBar",
        renderingMode = SessionParams.RenderingMode.SHRINK,
    )

    private val head = """{"version":1,"updatedAt":"2026-10-26T17:32:00Z","available":true,"counts":{"active":2,"stopped":1,"asking":1},"agents":[
        {"name":"impl-api","role":"impl","state":"asking","ageSeconds":300},
        {"name":"rev-front","role":"review","state":"active","ageSeconds":720},
        {"name":"spec-auth","role":"spec","state":"active","ageSeconds":5580},
        {"name":"docs","role":"docs","state":"stopped","ageSeconds":7800}]"""
    private val gib = 1L shl 30

    private fun system(used: Long, down: String, queue: String) = ""","system":{"memory":{"totalBytes":${32 * gib},"usedBytes":${used}},
        "infra":{"services":{"enabled":6,"up":${if (down.isEmpty()) 6 else 5},"required":2,"requiredUp":2,"down":[$down]},
        "containers":{"total":3,"up":3,"down":[]}},"queue":$queue}"""

    private fun prs(items: String) = ""","prs":{"available":true,"ageSeconds":120,"error":null,"items":[$items]}"""

    private val okJson = head + system(12 * gib, "", """{"running":null,"waiting":0}""") +
        prs("""{"number":412,"title":"Fluxo de login com SSO","reviewPending":true,"ci":"green"},
               {"number":409,"title":"Tela de faturas","reviewPending":false,"ci":"green"},
               {"number":405,"title":"Migração de usuários","reviewPending":false,"ci":"running"},
               {"number":398,"title":"Ajuste de cache","reviewPending":true,"ci":"green"},
               {"number":391,"title":"Docs da API","reviewPending":false,"ci":"none"}""") + "}"
    private val alertJson = head + system(28 * gib, "\"billing\"",
        """{"running":{"label":"build-api","ageSeconds":240,"rssBytes":${3 * gib}},"waiting":2}""") +
        prs("""{"number":412,"title":"Fluxo de login com SSO","reviewPending":true,"ci":"failing"},
               {"number":409,"title":"Tela de faturas","reviewPending":false,"ci":"failing"},
               {"number":405,"title":"Migração de usuários","reviewPending":false,"ci":"running"},
               {"number":398,"title":"Ajuste de cache","reviewPending":true,"ci":"green"}""") + "}"

    private fun input(json: String?, failure: FetchResult.Failure?) =
        WidgetInput(json?.let { WidgetParser.parse(it) }, failure, 0, ZoneOffset.UTC)

    private val states = linkedMapOf(
        "ok" to input(okJson, null),
        "alerta" to input(alertJson, null),
        "carregando" to input(null, null),
        "erro" to input(okJson, FetchResult.Failure.NETWORK),
    )

    private fun render(context: Context, view: WidgetView, input: WidgetInput, size: WidgetSize): View {
        val views = RemoteViews(context.packageName, view.layout(size))
        view.bind(views, input, size)
        val frame = FrameLayout(context)
        return views.apply(context, frame)
    }

    private fun shot(name: String, view: WidgetView, size: WidgetSize, state: String, dark: Boolean) {
        paparazzi.unsafeUpdateConfig(
            deviceConfig = DeviceConfig.PIXEL_5.copy(nightMode = if (dark) NightMode.NIGHT else NightMode.NOTNIGHT),
            theme = if (dark) "android:Theme.Material.NoActionBar" else "android:Theme.Material.Light.NoActionBar",
        )
        val density = paparazzi.context.resources.displayMetrics.density
        val widthDp = 250
        val heightDp = if (size == WidgetSize.REGULAR) 190 else 110
        val widget = render(paparazzi.context, view, states.getValue(state), size)
        val wrapper = FrameLayout(paparazzi.context)
        wrapper.addView(widget, FrameLayout.LayoutParams((widthDp * density).toInt(), (heightDp * density).toInt()))
        wrapper.layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        paparazzi.snapshot(wrapper, "$name-${size.name.lowercase()}-$state-${if (dark) "escuro" else "claro"}")
    }

    @Test
    fun allWidgets() {
        val widgets = mapOf("status" to StatusWidgetView(), "sistema" to SistemaWidgetView(), "prs" to PrsWidgetView())
        for ((name, view) in widgets) for (size in WidgetSize.values()) for (state in states.keys) for (dark in listOf(false, true)) {
            shot(name, view, size, state, dark)
        }
    }
}
