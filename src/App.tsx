// App.tsx
import { useEffect, useState } from 'react';

interface Tarefa {
  _id: string;
  texto: string;
  concluida: boolean;
}

function App() {
  const [tarefas, setTarefas] = useState<Tarefa[]>([]);
  const [novaTarefa, setNovaTarefa] = useState('');

  // Busca todas as tarefas do backend
  const fetchTarefas = async () => {
    try {
      const res = await fetch('http://localhost:5000/tarefas');
      const data = await res.json();
      setTarefas(data);
    } catch (err) {
      console.log('Erro ao buscar tarefas:', err);
    }
  };

  // Adicionar nova tarefa
  const adicionarTarefa = async () => {
    if (!novaTarefa.trim()) return; // não permite tarefa vazia
    try {
      const res = await fetch('http://localhost:5000/tarefas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ texto: novaTarefa }),
      });
      const data = await res.json();
      setTarefas([...tarefas, data]);
      setNovaTarefa('');
    } catch (err) {
      console.log('Erro ao adicionar tarefa:', err);
    }
  };

  // Riscar/desmarcar tarefa
  const riscarTarefa = async (id: string) => {
    try {
      const res = await fetch(`http://localhost:5000/tarefas/${id}`, { method: 'PUT' });
      const updated = await res.json();
      setTarefas(tarefas.map(t => (t._id === id ? updated : t)));
    } catch (err) {
      console.log('Erro ao atualizar tarefa:', err);
    }
  };

  // Apagar tarefa
  const apagarTarefa = async (id: string) => {
    try {
      await fetch(`http://localhost:5000/tarefas/${id}`, { method: 'DELETE' });
      setTarefas(tarefas.filter(t => t._id !== id));
    } catch (err) {
      console.log('Erro ao apagar tarefa:', err);
    }
  };

  // useEffect corrigido para lidar com async
  useEffect(() => {
    const carregarTarefas = async () => {
      try {
        await fetchTarefas();
      } catch (err) {
        console.log('Erro ao carregar tarefas:', err);
      }
    };
    carregarTarefas();
  }, []);

  return (
    <div style={{ maxWidth: '500px', margin: '50px auto', fontFamily: 'Arial, sans-serif' }}>
      <h1>Lista de Tarefas</h1>

      <div style={{ display: 'flex', marginBottom: '20px' }}>
        <input
          value={novaTarefa}
          onChange={(e) => setNovaTarefa(e.target.value)}
          placeholder="Escreve uma tarefa..."
          style={{ flex: 1, padding: '8px', marginRight: '10px' }}
        />
        <button onClick={adicionarTarefa} style={{ padding: '8px 12px', cursor: 'pointer' }}>
          Adicionar
        </button>
      </div>

      <ul style={{ listStyle: 'none', padding: 0 }}>
        {tarefas.map((t) => (
          <li
            key={t._id}
            style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '10px' }}
          >
            <span style={{ textDecoration: t.concluida ? 'line-through' : 'none' }}>{t.texto}</span>
            <div>
              <button onClick={() => riscarTarefa(t._id)} style={{ marginRight: '5px' }}>
                {t.concluida ? 'Desmarcar' : 'Concluir'}
              </button>
              <button onClick={() => apagarTarefa(t._id)}>Apagar</button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default App;