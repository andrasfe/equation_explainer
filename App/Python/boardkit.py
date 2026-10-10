"""boardkit - small helpers for doing quantum / linear-algebra work on the board.

    from boardkit import *

Everything is exact (sympy) unless you pass numpy arrays. Use show() to put a
result on the board: it prints LaTeX wrapped in $$ ... $$, which the app renders.
"""
from __future__ import annotations

import math
from functools import reduce

import numpy as np
import sympy as sp
from sympy import (I, Matrix, Rational, exp, pi, simplify, sqrt, symbols,  # noqa: F401
                   cos, sin, conjugate, eye, zeros, nsimplify, latex, expand, factor)
from sympy.physics.quantum import TensorProduct

__all__ = [
    "np", "sp", "I", "Matrix", "Rational", "exp", "pi", "simplify", "sqrt", "symbols",
    "cos", "sin", "conjugate", "eye", "zeros", "nsimplify", "latex", "expand", "factor",
    "ket", "bra", "braket", "ketbra", "inner", "outer", "kron", "tp", "dag", "I2", "X", "Y", "Z", "H", "S", "T", "CNOT", "CZ",
    "SWAP", "Gate", "Rx", "Ry", "Rz", "P", "U", "qft", "grover_diffusion", "oracle", "probs",
    "show", "show_state", "is_unitary", "commutator", "expval", "density", "ptrace",
]

# ----------------------------------------------------------------- states
def ket(bits: str | int, n: int | None = None) -> Matrix:
    """Computational basis column vector. ket('01'), ket(3, n=3), ket('+'), ket('-')."""
    if bits == "+":
        return Matrix([1, 1]) / sqrt(2)
    if bits == "-":
        return Matrix([1, -1]) / sqrt(2)
    if isinstance(bits, int):
        if n is None:
            n = max(1, bits.bit_length())
        bits = format(bits, f"0{n}b")
    v = zeros(2 ** len(bits), 1)
    v[int(bits, 2)] = 1
    return v


def bra(bits: str | int, n: int | None = None) -> Matrix:
    return dag(ket(bits, n))


def braket(a, b):
    """Inner product <a|b> of two kets (conjugates a)."""
    return simplify((dag(a) * b)[0])


def ketbra(a, b):
    """Outer product |a><b|."""
    return a * dag(b)


inner, outer = braket, ketbra


def dag(A):
    """Conjugate transpose (dagger)."""
    if isinstance(A, np.ndarray):
        return A.conj().T
    return A.H


def kron(*ms):
    """Tensor (Kronecker) product of any number of matrices / vectors."""
    if any(isinstance(m, np.ndarray) for m in ms):
        return reduce(np.kron, [np.asarray(m, dtype=complex) if not isinstance(m, np.ndarray) else m for m in ms])
    return reduce(lambda a, b: TensorProduct(a, b), ms)


tp = kron

# ----------------------------------------------------------------- gates
class Gate(sp.MutableDenseMatrix):
    """A sympy Matrix that is also callable, because people (and models) write H(...):

    H()        -> H
    H(3)       -> H ⊗ H ⊗ H
    H(state)   -> H * state
    """

    def __call__(self, arg=1):
        if isinstance(arg, (int, sp.Integer)):
            return Matrix(reduce(lambda a, b: TensorProduct(a, b), [Matrix(self)] * int(arg)))
        return Matrix(self) * arg


def _gate(rows, scale=1):
    return Gate(Matrix(rows) * scale)


I2 = _gate(eye(2))
X = _gate([[0, 1], [1, 0]])
Y = _gate([[0, -I], [I, 0]])
Z = _gate([[1, 0], [0, -1]])
H = _gate([[1, 1], [1, -1]], 1 / sqrt(2))
S = _gate([[1, 0], [0, I]])
T = _gate([[1, 0], [0, exp(I * pi / 4)]])
CNOT = _gate([[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 0, 1], [0, 0, 1, 0]])
CZ = _gate([[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, -1]])
SWAP = _gate([[1, 0, 0, 0], [0, 0, 1, 0], [0, 1, 0, 0], [0, 0, 0, 1]])


def Rx(t):
    return Matrix([[cos(t / 2), -I * sin(t / 2)], [-I * sin(t / 2), cos(t / 2)]])


def Ry(t):
    return Matrix([[cos(t / 2), -sin(t / 2)], [sin(t / 2), cos(t / 2)]])


def Rz(t):
    return Matrix([[exp(-I * t / 2), 0], [0, exp(I * t / 2)]])


def P(phi):
    """Phase gate diag(1, e^{i phi})."""
    return Matrix([[1, 0], [0, exp(I * phi)]])


def U(theta, phi, lam):
    """General single-qubit gate U(θ, φ, λ) (OpenQASM convention)."""
    return Matrix([
        [cos(theta / 2), -exp(I * lam) * sin(theta / 2)],
        [exp(I * phi) * sin(theta / 2), exp(I * (phi + lam)) * cos(theta / 2)],
    ])


def qft(n: int) -> Matrix:
    """n-qubit quantum Fourier transform matrix, F_{jk} = ω^{jk}/√N with ω = e^{2πi/N}."""
    N = 2 ** n
    w = exp(2 * pi * I / N)
    return Matrix(N, N, lambda j, k: w ** (j * k)) / sqrt(N)


def grover_diffusion(n: int) -> Matrix:
    """D = 2|s><s| - I on n qubits, |s> the uniform superposition."""
    N = 2 ** n
    s = Matrix([1] * N) / sqrt(N)
    return 2 * s * s.H - eye(N)


def oracle(marked, n: int) -> Matrix:
    """Phase oracle flipping the sign of the marked basis state(s)."""
    marked = [marked] if isinstance(marked, (int, str)) else list(marked)
    O = eye(2 ** n)
    for m in marked:
        idx = int(m, 2) if isinstance(m, str) else int(m)
        O[idx, idx] = -1
    return O

# ----------------------------------------------------------------- analysis
def probs(state, digits: int = 6) -> dict:
    """Measurement probabilities of a state vector in the computational basis."""
    v = state if isinstance(state, np.ndarray) else np.array(sp.N(Matrix(state)), dtype=complex)
    v = v.reshape(-1)
    n = int(round(math.log2(len(v))))
    return {format(i, f"0{n}b"): round(float(abs(a) ** 2), digits) for i, a in enumerate(v) if abs(a) > 1e-12}


def is_unitary(A) -> bool:
    if isinstance(A, np.ndarray):
        return bool(np.allclose(A.conj().T @ A, np.eye(A.shape[0])))
    return simplify(A.H * A - eye(A.shape[0])) == zeros(*A.shape)


def commutator(A, B):
    return A * B - B * A


def expval(op, state):
    """<ψ|op|ψ> for a state vector."""
    return simplify((dag(state) * op * state)[0])


def density(state):
    return state * dag(state)


def ptrace(rho, keep, dims=None):
    """Partial trace of a density matrix; keep = list of subsystem indices (qubits by default)."""
    rho_np = np.array(sp.N(rho), dtype=complex) if not isinstance(rho, np.ndarray) else rho
    n = int(round(math.log2(rho_np.shape[0])))
    dims = dims or [2] * n
    keep = sorted(keep)
    t = rho_np.reshape(dims + dims)
    trace_out = [i for i in range(len(dims)) if i not in keep]
    for count, i in enumerate(sorted(trace_out, reverse=True)):
        t = np.trace(t, axis1=i, axis2=i + t.ndim // 2)
    d = int(np.prod([dims[i] for i in keep]))
    return t.reshape(d, d)

# ----------------------------------------------------------------- output
def _to_latex(obj) -> str:
    if isinstance(obj, np.ndarray):
        arr = np.round(obj, 6)
        if np.iscomplexobj(arr) and np.allclose(arr.imag, 0):
            arr = arr.real
        return latex(Matrix(arr.tolist()).applyfunc(lambda x: nsimplify(x, tolerance=1e-9, rational=False)))
    if isinstance(obj, dict):
        def key(k):
            ks = str(k)
            return rf"\ket{{{ks}}}" if ks and set(ks) <= set("01+-") else rf"\text{{{ks}}}"
        items = list(obj.items())
        if len(items) <= 8:  # horizontal outcome table
            head = " & ".join(key(k) for k, _ in items)
            vals = " & ".join(r"\displaystyle " + _to_latex(v) for _, v in items)
            return r"\begin{array}{" + "c" * len(items) + "}" + head + r" \\[4pt] " + vals + r"\end{array}"
        rows = r" \\[3pt] ".join(rf"{key(k)} & \displaystyle {_to_latex(v)}" for k, v in items)
        return r"\begin{array}{ll}" + rows + r"\end{array}"
    if isinstance(obj, (list, tuple)):
        return r",\; ".join(_to_latex(o) for o in obj)
    if isinstance(obj, str):
        return r"\text{" + obj.replace("\\", r"\backslash ").replace("{", r"\{").replace("}", r"\}") + "}"
    if isinstance(obj, bool):
        return r"\text{" + str(obj) + "}"
    if isinstance(obj, (float, complex)):
        return latex(nsimplify(obj, tolerance=1e-10, rational=False))
    try:
        return latex(obj)
    except Exception:  # noqa: BLE001
        return r"\text{" + str(obj) + "}"


def show(obj, label: str | None = None, simplify_first: bool = True) -> None:
    """Print obj as LaTeX for the board: $$label = obj$$."""
    if simplify_first and isinstance(obj, (sp.MatrixBase, sp.Expr)):
        try:
            obj = simplify(obj)
        except Exception:  # noqa: BLE001
            pass
    tex = _to_latex(obj)
    if "matrix}" in tex and "\\frac" in tex:  # give stacked fractions room to breathe
        tex = r"\def\arraystretch{1.7}" + tex
    print(f"$${label} = {tex}$$" if label else f"$${tex}$$", flush=True)


def show_state(state, label: str = r"\ket{\psi}") -> None:
    """Show a state vector in Dirac notation, e.g. (1/√2)|00> + (1/√2)|11>."""
    v = Matrix(state)
    n = int(round(math.log2(v.shape[0])))
    terms = []
    for i, a in enumerate(v):
        a = simplify(a)
        if a == 0:
            continue
        coeff = latex(a)
        if a == 1:
            coeff = ""
        elif a == -1:
            coeff = "-"
        elif isinstance(a, sp.Add):
            coeff = r"\left(" + coeff + r"\right)"
        terms.append(f"{coeff}\\ket{{{format(i, f'0{n}b')}}}")
    body = " + ".join(terms).replace("+ -", "- ") or "0"
    print(f"$${label} = {body}$$", flush=True)
