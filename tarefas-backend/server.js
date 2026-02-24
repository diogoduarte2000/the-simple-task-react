const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json());
mongoose.connect('mongodb+srv://diogoduarte2000:klonoa2026@cluster0.h7kvt84.mongodb.net/tarefasDB?retryWrites=true&w=majority')
.then(() => console.log('MongoDB conectado!'))
.catch((err) => console.log('Erro ao conectar MongoDB:', err));
const TarefaSchema = new mongoose.Schema({ texto: String, concluida: Boolean });
const Tarefa = mongoose.model('Tarefa', TarefaSchema);
app.get('/tarefas', async (req, res) => { try { res.json(await Tarefa.find()); } catch (err) { res.status(500).json({ erro: 'Erro' }); } });
app.post('/tarefas', async (req, res) => { try { const t = new Tarefa({ texto: req.body.texto, concluida: false }); await t.save(); res.json(t); } catch (err) { res.status(500).json({ erro: 'Erro' }); } });
app.put('/tarefas/:id', async (req, res) => { try { const t = await Tarefa.findById(req.params.id); t.concluida = !t.concluida; await t.save(); res.json(t); } catch (err) { res.status(500).json({ erro: 'Erro' }); } });
app.delete('/tarefas/:id', async (req, res) => { try { await Tarefa.findByIdAndDelete(req.params.id); res.json({ message: 'Apagada' }); } catch (err) { res.status(500).json({ erro: 'Erro' }); } });
app.listen(5000, () => console.log('Servidor a correr na porta 5000'));
