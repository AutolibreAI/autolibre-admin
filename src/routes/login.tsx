import { SignIn } from '@clerk/tanstack-react-start'
import { createFileRoute, redirect } from '@tanstack/react-router'
import { loginSearchSchema } from '~/lib/search'

export const Route = createFileRoute('/login')({
  // Even a single optional param goes through a schema — `redirect` must be a
  // relative path (`.startsWith('/')`), otherwise this is an open redirect and
  // Clerk would happily bounce a signed-in admin to someone else's domain.
  validateSearch: loginSearchSchema,

  beforeLoad: ({ context, search }) => {
    if (context.user) throw redirect({ to: search.redirect ?? '/dashboard' })
  },

  head: () => ({ meta: [{ title: 'Iniciar sesión — AutoLibre' }] }),

  /**
   * SSR MODE: false.
   *
   * Clerk's `<SignIn />` mounts against `window` and reads the client-side
   * session before deciding what to render. Server-rendering it produces markup
   * for the signed-out state that is discarded a tick later — a guaranteed
   * hydration mismatch on the one screen where a flicker is most visible.
   *
   * The route's guard above still runs on the server, so an already-signed-in
   * admin is redirected before any of this ships.
   */
  ssr: false,

  component: LoginPage,
})

function LoginPage() {
  const { redirect: redirectTo } = Route.useSearch()

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
      <div className="font-heading text-2xl font-bold tracking-tight">
        Auto<span className="text-brand">Libre</span>
      </div>
      <p className="mb-6 mt-1 text-sm text-muted-foreground">Panel de administración</p>

      <SignIn
        routing="hash"
        forceRedirectUrl={redirectTo ?? '/dashboard'}
        signUpUrl="/login"
      />

      <p className="mt-6 text-xs leading-relaxed text-muted-foreground">
        El acceso al panel requiere una cuenta con rol <span className="font-medium">admin</span>.
        Una sesión válida de la app no alcanza.
      </p>
    </main>
  )
}
