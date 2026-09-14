import { SignIn, SignOutButton, useAuth, useUser } from '@clerk/tanstack-react-start'
import { createFileRoute, redirect } from '@tanstack/react-router'
import { Button } from '~/components/ui/button'
import { Card, CardContent } from '~/components/ui/card'
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
  const { isLoaded, isSignedIn } = useAuth()
  const { user: clerkUser } = useUser()

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
      <div className="font-heading text-2xl font-bold tracking-tight">
        Auto<span className="text-brand">Libre</span>
      </div>
      <p className="mb-6 mt-1 text-sm text-muted-foreground">Panel de administración</p>

      {/*
       * Clerk dice "hay sesión" y el servidor dijo "no hay usuario" (si no, el
       * beforeLoad ya habría redirigido). Pasa cuando la identidad de Clerk no
       * tiene fila en `users` — o no matchea por (auth_provider, external_auth_id).
       * `<SignIn />` con una sesión activa NO renderiza nada, así que sin este
       * bloque la pantalla queda en blanco y sin forma de cerrar sesión.
       */}
      {isLoaded && isSignedIn ? (
        <Card>
          <CardContent className="pt-6">
            <h1 className="text-base font-semibold">Tu sesión no tiene usuario de AutoLibre</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {clerkUser?.primaryEmailAddress ? (
                <>
                  Entraste como{' '}
                  <span className="font-medium text-foreground">
                    {clerkUser.primaryEmailAddress.emailAddress}
                  </span>
                  , pero esa identidad no está vinculada a ningún usuario de la base.
                </>
              ) : (
                <>Hay una sesión abierta, pero no está vinculada a ningún usuario de la base.</>
              )}
            </p>
            <SignOutButton redirectUrl="/login">
              <Button variant="outline" size="sm" className="mt-4">
                Cerrar sesión y entrar con otra cuenta
              </Button>
            </SignOutButton>
          </CardContent>
        </Card>
      ) : (
        <SignIn
          routing="hash"
          forceRedirectUrl={redirectTo ?? '/dashboard'}
          signUpUrl="/login"
        />
      )}

      <p className="mt-6 text-xs leading-relaxed text-muted-foreground">
        El acceso al panel requiere una cuenta con rol <span className="font-medium">admin</span>.
        Una sesión válida de la app no alcanza.
      </p>
    </main>
  )
}
