import { Injectable, Type } from '@angular/core'
import { Observable, Subject } from 'rxjs'

/**
 * Hosts one plugin-provided panel on the left side of the window, next to the profile tree.
 * The panel component injects its own state; this service only decides which one is shown.
 */
@Injectable({ providedIn: 'root' })
export class SidePanelService {
    get component (): Type<any>|null { return this.current }
    get changed$ (): Observable<Type<any>|null> { return this.changed }

    private current: Type<any>|null = null
    private changed = new Subject<Type<any>|null>()

    show (component: Type<any>): void {
        if (this.current === component) {
            return
        }
        this.current = component
        this.changed.next(component)
    }

    hide (): void {
        if (!this.current) {
            return
        }
        this.current = null
        this.changed.next(null)
    }

    isShown (component: Type<any>): boolean {
        return this.current === component
    }
}
